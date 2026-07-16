import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { makeCodingSpawn } from './privilege';
import { buildTaskPrompt, robotSystemPrompt, VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER } from './prompt';
import type { Worktree } from './workspace';
import type { RobotCandidate } from './select';

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
  /** On !ok, the SDK error text (billing / rate-limit / max-turns / crash). */
  error?: string;
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
    : {};
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
  runQuery: RunQuery = query,
): Promise<RobotSessionResult> {
  const prompt = buildTaskPrompt({
    title: candidate.title,
    body: candidate.body,
    branch: worktree.branch,
    repo: candidate.repo,
    issueNumber: candidate.issueNumber,
    proxy: config.httpsProxy,
  });

  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;

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
      if (message.type === 'result') {
        sessionId = message.session_id;
        ok = message.subtype === 'success' && !message.is_error;
        if (!ok) error = message.subtype === 'success' ? 'is_error' : (message.errors ?? []).join('; ');
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, ticketId: candidate.id }, 'robot: coding session threw');
  }

  const handoff = readHandoff(worktree.dir);
  return { ok, sessionId, error, ...handoff };
}
