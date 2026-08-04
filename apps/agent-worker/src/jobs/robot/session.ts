import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { makeCodingSpawn } from './privilege';
import { buildTaskPrompt, robotSystemPrompt, VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER, type ResumeContext } from './prompt';
import type { Worktree } from './workspace';
import type { RobotCandidate } from './select';
import { OUTPUT_TAIL_MAX } from './runs';

/**
 * The Robot coding session (D-055, PD-342): one write-enabled Agent-SDK session that implements a
 * ticket in its worktree and hands off a PR. Spawned via the uid-split hook so the `claude`
 * subprocess runs under the low-priv coding uid (privilege.ts). The session is headless
 * (`bypassPermissions`) — an interactive prompt would hang unattended.
 *
 * The loop does NOT trust the session's word for success: after it ends, the loop reads the
 * filesystem hand-off signals the Robot left (`.robot/verify-ok` + `.robot/scm.json`). The
 * verify-ok marker gate (D-046) is what distinguishes a real hand-off from an abandoned WIP tree.
 */

export interface RobotSessionResult {
  /** True when the SDK reported a clean result (subtype success, not is_error). */
  ok: boolean;
  /** The coding session id, for cross-referencing logs (persisted on the run row). */
  sessionId?: string;
  /** `.robot/verify-ok` present ⇒ the Robot reached a green verify (D-046 gate). */
  verifyOk: boolean;
  /** PR number from `.robot/scm.json`, when the Robot opened one. */
  prNumber?: number;
  /** The Robot's blocking question from `.robot/ask-human`, when it deliberately parked (C2). */
  askHuman?: string;
  /** SDK turns the session used, from the result message (observability, C3). */
  turns?: number;
  /** Total tokens the session used (input+output, from the result usage; C3). */
  tokens?: number;
  /** On !ok, the SDK error text (billing / rate-limit / max-turns / crash). */
  error?: string;
  /** Last `OUTPUT_TAIL_MAX` chars of the session's assistant text + tool output (PD-426).
   *  The evidence a `no-verify` run leaves behind — see the capture note below. */
  outputTail?: string;
}

/**
 * Output-tail capture (PD-426). A `no-verify` run used to be undiagnosable: the SDK stream is
 * consumed here for `session_id`/`num_turns`/`usage` and everything else — including the
 * `npm run verify` output — was dropped, while the worktree is removed in robot.ts's `finally`.
 * The run row outlives both, so a bounded tail of the stream is captured onto it.
 *
 * TAIL, not head: the interesting part of a failed run is the end (what verify said, where it gave
 * up), so the FRONT is truncated when the cap is hit.
 */
const TRUNCATION_MARKER = '…[truncated]\n';

/** Append to a rolling buffer capped at `max` chars, discarding from the front. The result is
 *  never longer than `max`, and carries a leading marker once anything has been dropped. */
export function appendTail(buf: string, chunk: string, max: number = OUTPUT_TAIL_MAX): string {
  if (!chunk) return buf;
  const next = buf ? `${buf}\n${chunk}` : chunk;
  if (next.length <= max) return next;
  // Re-truncating an already-truncated buffer just eats into the old marker, so the length stays
  // pinned at exactly `max` rather than growing by a marker each time.
  return TRUNCATION_MARKER + next.slice(next.length - max + TRUNCATION_MARKER.length);
}

/**
 * Pull human-readable text out of one SDK message: assistant text blocks and tool results (the
 * latter is where `npm run verify`'s stdout/stderr lives, which is the whole point).
 *
 * Read defensively — same posture as the existing `num_turns`/`usage` handling. The SDK's block
 * shapes are not guaranteed here, so anything unrecognized is skipped rather than assumed.
 */
export function extractMessageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return '';
  const m = message as { type?: string; message?: { content?: unknown } };
  const role = m.type === 'assistant' ? '[assistant]' : '[tool]';
  const content = m.message?.content;
  const parts: string[] = [];

  const pushBlock = (block: unknown): void => {
    const b = block as { type?: string; text?: string; content?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') parts.push(b.content);
      else if (Array.isArray(b.content)) b.content.forEach(pushBlock);
    }
  };

  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) content.forEach(pushBlock);

  const text = parts.join('\n').trim();
  return text ? `${role} ${text}` : '';
}

/** The env handed to the coding subprocess. Inherits the loop env for PATH/ANTHROPIC_API_KEY,
 *  then injects the WRITE token as GH_TOKEN and the proxy so git/gh/npm reach GitHub + the registry
 *  through squid. The read token is intentionally NOT forwarded — a Robot pushes with the write
 *  token or not at all. When the uid is dropped, HOME/USER are repointed at the coding user's
 *  home (inheriting root's HOME would be unreadable to the dropped uid). */
export function codingEnv(config: AgentWorkerConfig): Record<string, string | undefined> {
  const { writeToken, codingUid, codingHome } = config.robot;
  const proxyVars = config.httpsProxy
    ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy, NODE_USE_ENV_PROXY: '1' }
    : { HTTPS_PROXY: undefined, HTTP_PROXY: undefined };
  // Only override HOME when actually dropping privilege; in dev (no uid) the inherited HOME is right.
  const homeVars =
    codingUid !== undefined ? { HOME: codingHome, USER: 'robot', LOGNAME: 'robot' } : {};
  return {
    ...process.env,
    GITHUB_READ_TOKEN: undefined,
    ...proxyVars,
    ...homeVars,
    ...(writeToken ? { GH_TOKEN: writeToken, GITHUB_TOKEN: writeToken } : {}),
  };
}

/** Read the hand-off signals the Robot left in its worktree. */
export function readHandoff(worktreeDir: string): { verifyOk: boolean; prNumber?: number; askHuman?: string } {
  const verifyOk = existsSync(path.join(worktreeDir, VERIFY_OK_MARKER));
  let prNumber: number | undefined;
  try {
    const scm = JSON.parse(readFileSync(path.join(worktreeDir, SCM_JSON), 'utf8')) as { pr_number?: number };
    if (typeof scm.pr_number === 'number') prNumber = scm.pr_number;
  } catch {
    // no scm.json (session didn't reach the PR step) — prNumber stays undefined
  }
  let askHuman: string | undefined;
  try {
    const q = readFileSync(path.join(worktreeDir, ASK_HUMAN_MARKER), 'utf8').trim();
    if (q) askHuman = q;
  } catch {
    // no ask-human marker — the Robot didn't park for a human
  }
  return { verifyOk, prNumber, askHuman };
}

/** Injectable SDK query (tests swap the real subprocess out). */
export type RunQuery = typeof query;

/**
 * Run one coding session end-to-end and report the observed hand-off. `runQuery` is injectable
 * so orchestration tests never spawn a real `claude`.
 */
export async function runRobotSession(
  config: AgentWorkerConfig,
  candidate: RobotCandidate,
  worktree: Worktree,
  resume: ResumeContext | undefined = undefined,
  runQuery: RunQuery = query,
  onProgress?: (turns: number) => void,
): Promise<RobotSessionResult> {
  const prompt = buildTaskPrompt({
    title: candidate.title,
    body: candidate.body,
    branch: worktree.branch,
    repo: candidate.repo,
    issueNumber: candidate.issueNumber,
    proxy: config.httpsProxy,
    resume,
  });

  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let turns: number | undefined;
  let tokens: number | undefined;
  /** Running count of assistant messages — the live stand-in for the SDK's final `num_turns`. */
  let liveTurns = 0;
  /** Rolling tail of what the session said and ran (PD-426). */
  let outputTail = '';

  try {
    for await (const message of runQuery({
      prompt,
      options: {
        model: config.model,
        cwd: worktree.dir,
        systemPrompt: robotSystemPrompt(),
        maxTurns: config.robot.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: codingEnv(config),
        // Kernel-enforced uid drop for the coding subprocess (D-055).
        spawnClaudeCodeProcess: makeCodingSpawn(config),
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
      // PD-426: capture assistant text + tool results. Unlike the turn counter below this does
      // NOT filter on parent_tool_use_id — sub-agent output is exactly the kind of evidence a
      // failed run needs. Capture must never break the session, hence the guard.
      if (message.type === 'assistant' || message.type === 'user') {
        try {
          outputTail = appendTail(outputTail, extractMessageText(message));
        } catch (err) {
          logger.warn({ err, ticketId: candidate.id }, 'robot: output-tail capture failed');
        }
      }
      // PD-230: live turn progress. The SDK only reports authoritative `num_turns` on the final
      // result message, so a `working` run would otherwise show no progress at all. Counting
      // assistant messages is an APPROXIMATION of that number; it exists so the board can show
      // "how close is this run to the cap" while it runs, and is overwritten with the real value
      // by finishRun. Never let a reporting failure kill the session.
      // Only TOP-LEVEL assistant messages count. Ones emitted inside a tool-use / sub-agent
      // context carry a non-null `parent_tool_use_id` and are not turns of the main loop —
      // counting them would inflate the live number well past the SDK's final `num_turns`.
      if (message.type === 'assistant' && message.parent_tool_use_id == null && onProgress) {
        liveTurns += 1;
        try {
          onProgress(liveTurns);
        } catch (err) {
          logger.warn({ err, ticketId: candidate.id }, 'robot: turn-progress report failed');
        }
      }
      if (message.type === 'result') {
        sessionId = message.session_id;
        ok = message.subtype === 'success' && !message.is_error;
        if (!ok) error = message.subtype === 'success' ? 'is_error' : (message.errors ?? []).join('; ');
        // Observability metrics (C3): turns + total tokens off the result message. Read
        // defensively — the SDK shape carries num_turns + a usage object.
        const r = message as { num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number } };
        if (typeof r.num_turns === 'number') turns = r.num_turns;
        if (r.usage) tokens = (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, ticketId: candidate.id }, 'robot: coding session threw');
  }

  const handoff = readHandoff(worktree.dir);
  // Empty tail (a session that produced nothing) reports as undefined, not '', so the column
  // stays null rather than storing a meaningless empty string.
  return { ok, sessionId, error, turns, tokens, outputTail: outputTail || undefined, ...handoff };
}
