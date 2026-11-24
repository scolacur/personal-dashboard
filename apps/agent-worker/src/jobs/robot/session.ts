import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { buildOrientation } from './orientation';
import { makeCodingSpawn } from './privilege';
import { buildTaskPrompt, robotSystemPrompt, VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER, VISUAL_REVIEW_MARKER, type ResumeContext } from '@dashboard/shared';
import { buildDocsToolServer } from './docs-tool';
import { buildDecisionToolServer } from './decision-tool';
import type { Worktree } from './workspace';
import type { RobotCandidate } from './select';
import { OUTPUT_TAIL_MAX } from './runs';
import { appendTranscript, transcriptEntries, type TranscriptEntry } from './progress';

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
  /** PD-773: what the Robot wants Steve to look at, from `.robot/visual-review`, when it asked. */
  visualReview?: string;
  /** SDK turns the session used, from the result message (observability, C3). */
  turns?: number;
  /** Total tokens the session used (input+output, from the result usage; C3). */
  tokens?: number;
  /** On !ok, the SDK error text (billing / rate-limit / max-turns / crash). */
  error?: string;
  /** Last `OUTPUT_TAIL_MAX` chars of the session's assistant text + tool output (PD-426).
   *  The evidence a `no-verify` run leaves behind — see the capture note below. */
  outputTail?: string;
  /** PD-964: what this segment did and saw, for the progress check's tripwires and judge. Turn
   *  numbers are run-wide (offset by `SessionSegment.turnOffset`). */
  transcript?: TranscriptEntry[];
}

/**
 * PD-964 (D-114): one window of a run. The first window starts the session; each later one RESUMES
 * it (`resume: sessionId`) with a short "keep going" prompt, so a run that passed its progress check
 * carries on with everything it knew — no new orientation, no re-reading. The window's length is the
 * candidate's `maxTurns`, which the loop sets per window.
 */
export interface SessionSegment {
  /** Resume this session instead of starting a new one. */
  resumeSessionId?: string;
  /** Turns already used by earlier windows of this run, so transcript turn numbers read run-wide. */
  turnOffset?: number;
}

/** The prompt that resumes a session after it passed a progress check. */
export const PROGRESS_CONTINUE_PROMPT = [
  'Progress check passed: keep going from exactly where you are.',
  'Your instructions have not changed. Continue the ticket, and do the full hand-off when it is done.',
].join('\n');

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

/**
 * What the coding session may inherit from the worker's env (PD-777, D-098). An ALLOWLIST: the
 * worker's env holds its own secrets (the read token, the review-gate token, whatever is added to
 * `agent-worker.env` next), and a denylist leaks every one somebody forgets to strip. Anything not
 * named here never reaches the Robot.
 *
 * The model credential is on the list because the SDK subprocess cannot run without it; the Robot
 * reading its own credential is inherent, and the egress allowlist keeps it from leaving.
 */
export const CODING_ENV_ALLOWED: readonly string[] = [
  // System basics a shell, git, node and npm expect.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'TMPDIR',
  // Model credential and SDK config (the session cannot run without one of the first two).
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  // Trust store, so TLS through the proxy verifies.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // Hosts that bypass the proxy (the proxy URL itself is injected from config below).
  'NO_PROXY',
  'no_proxy',
];

/** Prefixes allowed wholesale: locale categories only. */
const CODING_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/** The allowed subset of `env`. Pure. */
export function allowedCodingEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (CODING_ENV_ALLOWED.includes(k) || CODING_ENV_ALLOWED_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/** The env handed to the coding subprocess: the allowlisted part of the loop env (PD-777), then
 *  the WRITE token as GH_TOKEN and the proxy so git/gh/npm reach GitHub + the registry through
 *  squid. The read token and the review-gate token are worker-only and never reach it (PD-763).
 *  The worker's NODE_ENV=production is not on the list either: it made the Robot's `npm ci` omit
 *  devDependencies, so verify could not build (found on PD-714's run, 2026-11-13). When the uid is
 *  dropped, HOME/USER are repointed at the coding user's home (inheriting root's HOME would be
 *  unreadable to the dropped uid). */
export function codingEnv(config: AgentWorkerConfig): Record<string, string | undefined> {
  const { writeToken, codingUid, codingHome } = config.robot;
  const proxyVars = config.httpsProxy
    ? {
        HTTPS_PROXY: config.httpsProxy,
        HTTP_PROXY: config.httpsProxy,
        https_proxy: config.httpsProxy,
        http_proxy: config.httpsProxy,
        NODE_USE_ENV_PROXY: '1',
      }
    : {};
  // Only override HOME when actually dropping privilege; in dev (no uid) the inherited HOME is right.
  const homeVars =
    codingUid !== undefined ? { HOME: codingHome, USER: 'robot', LOGNAME: 'robot' } : {};
  return {
    ...allowedCodingEnv(process.env),
    ...proxyVars,
    ...homeVars,
    ...(writeToken ? { GH_TOKEN: writeToken, GITHUB_TOKEN: writeToken } : {}),
  };
}

/** Read the hand-off signals the Robot left in its worktree. */
export function readHandoff(worktreeDir: string): { verifyOk: boolean; prNumber?: number; askHuman?: string; visualReview?: string } {
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
  let visualReview: string | undefined;
  try {
    const v = readFileSync(path.join(worktreeDir, VISUAL_REVIEW_MARKER), 'utf8').trim();
    if (v) visualReview = v.slice(0, 500);
  } catch {
    // no visual-review marker — the Robot did not ask for a visual check
  }
  return { verifyOk, prNumber, askHuman, ...(visualReview ? { visualReview } : {}) };
}

/**
 * The Robot's tool surface (PD-486, [[D-068]]) — declared, not inherited.
 *
 * Before this, the session passed no tool option at all, so it ran with the SDK's full default set.
 * That silently included **`Task`** (sub-agent spawning) at unbounded depth, which nobody chose —
 * and sub-agent turns are invisible to the cap: assistant messages inside a sub-agent carry a
 * non-null `parent_tool_use_id` and are excluded from `num_turns` (see the turn counter below). One
 * main-loop turn could therefore spawn a sub-agent that burned arbitrarily many, straight through
 * PD-432's per-ticket ceiling and the turns limb of PD-463's budget.
 *
 * **Use `tools`, not `allowedTools`.** This is the trap: `allowedTools` is a *permission*
 * auto-approve list ("execute without asking"), and under `bypassPermissions` nothing asks anyway —
 * setting it here would restrict nothing. `tools` is the one that "specifies the base set of
 * available built-in tools". Anything absent from this list does not exist for the session.
 *
 * An allowlist, deliberately, rather than denying `Task`: a denylist admits every future SDK tool by
 * default, which is exactly how `Task` arrived unnoticed. New capability should be opt-in.
 *
 * Each entry earns its place from what `prompt.ts` actually asks for:
 *  - `Bash` — every Finish step: npm ci / verify, git, gh, the marker files.
 *  - `BashOutput` / `KillShell` — managing a command already started, not new capability. `npm ci`
 *    plus a full verify is minutes long and may be backgrounded; without these a backgrounded
 *    command is unreachable and the run hangs rather than fails, which is far worse to diagnose.
 *  - `Read` / `Write` / `Edit` — Step 1 orient (PROJECT.md, CLAUDE.md, DECISIONS.md) and Step 2.
 *  - `Glob` / `Grep` — finding the code to change. The SDK notes these must be listed explicitly or
 *    search silently degrades to `find`/`grep` through Bash.
 *  - `TodoWrite` — bookkeeping across a long multi-step run; no side effects outside the session.
 *
 * Excluded on purpose: `Task` (above); `WebFetch` / `WebSearch`, which the egress allowlist would
 * refuse anyway and whose absence is the premise of PD-310; `NotebookEdit`, no notebooks here.
 */
export const ROBOT_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TodoWrite',
];

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
  onProgress?: (turns: number, tokens?: number) => void,
  // PD-564: the worker's DB handle, used only to build the decision-id tool. Optional and last so
  // the existing positional call sites are untouched; the loop always passes it, and
  // `robot.spec.ts` guards that it does — an absent handle silently costs the Robot its ability to
  // record a decision, which is the kind of loss nothing else would report.
  db?: Database.Database,
  // PD-784/D-104: aborts the SDK query on a graceful stop (SIGTERM). The loop creates one per
  // dispatch, registers it in the ownership registry, and triggers it from the shutdown coordinator.
  // Optional/last so existing positional call sites are untouched.
  abortController?: AbortController,
  // PD-964: which window of the run this is. Absent = a fresh session (the first window).
  segment: SessionSegment = {},
): Promise<RobotSessionResult> {
  const resuming = !!segment.resumeSessionId;
  const turnOffset = segment.turnOffset ?? 0;
  const prompt = resuming ? PROGRESS_CONTINUE_PROMPT : buildTaskPrompt({
    title: candidate.title,
    body: candidate.body,
    branch: worktree.branch,
    repo: candidate.repo,
    // Fall back to `#<id>` so the envelope never prints `undefined` when display_id is null.
    displayId: candidate.displayId ?? `#${candidate.id}`,
    issueNumber: candidate.issueNumber,
    proxy: config.httpsProxy,
    resume,
  });

  // PD-564: `db` is optional only so the existing positional call sites keep compiling; the loop
  // always passes one. Without it the Robot has no way to allocate a decision id, and nothing else
  // in the run would report that — so say so rather than degrade quietly.
  if (!db) {
    logger.warn(
      { ticketId: candidate.id },
      'robot: no DB handle passed to the session — mcp__decisions__allocate is NOT available this run',
    );
  }

  let ok = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  let turns: number | undefined;
  let tokens: number | undefined;
  /** Live stand-in for the SDK's final `num_turns`: the count of DISTINCT top-level assistant
   *  `message.id`s seen so far (T-902). The SDK emits one assistant message per content block, so
   *  a single turn (text + a tool call) arrives as several messages sharing one id — counting
   *  messages double-counts. `seenTurnIds` dedupes them; `liveTurns` is its size plus any id-less
   *  messages counted defensively below. */
  let liveTurns = 0;
  const seenTurnIds = new Set<string>();
  /** PD-898: running input+output token total, summed once per distinct turn (same dedupe as
   *  `liveTurns` — every content-block message of a turn repeats that turn's usage). Undefined until
   *  a message carries usage, so a shape change reports "unknown", never a false 0. An approximation
   *  like `liveTurns`: finishRun overwrites it with the result message's authoritative usage. */
  let liveTokens: number | undefined;
  /** Rolling tail of what the session said and ran (PD-426). */
  let outputTail = '';
  /** PD-964: the window transcript the progress check reads. */
  const transcript: TranscriptEntry[] = [];

  try {
    for await (const message of runQuery({
      prompt,
      options: {
        model: config.model,
        cwd: worktree.dir,
        // PD-964: a later window resumes the same session — same context, same tools, more turns.
        ...(resuming ? { resume: segment.resumeSessionId } : {}),
        // PD-784/D-104: a graceful stop aborts this; the SDK stops the query and the loop closes the
        // run as a transient `interrupted` fault.
        ...(abortController ? { abortController } : {}),
        systemPrompt: robotSystemPrompt(
          buildOrientation({
            repoDir: worktree.dir,
            onMissing: (what) =>
              logger.warn({ what, ticketId: candidate.id }, 'robot: orientation source missing — the run is degraded'),
          }),
        ),
        // PD-486: the base set of tools that exist for this session. `Task` is absent, so the
        // Robot cannot spawn sub-agents whose turns the cap can't see. See ROBOT_TOOLS.
        tools: [...ROBOT_TOOLS],
        // PD-310/D-075: the documentation read path. `tools` above governs BUILT-IN tools only, so
        // registering an in-process MCP server here adds `mcp__docs__fetch` without reopening
        // D-068's allowlist — `WebFetch` remains absent and the agent still cannot reach the
        // network itself. The worker makes the request on its behalf.
        mcpServers: {
          docs: buildDocsToolServer(config, candidate.id),
          // PD-564: how the Robot gets a real `D-NNN`. Same division as the docs tool — the agent
          // supplies intent, the WORKER performs the privileged act — which is what lets a Robot
          // allocate an id while remaining unable to touch `dashboard.db` (D-055, D-087).
          // It is here rather than an HTTP call because the container's egress firewall makes the
          // PD-557 endpoint unreachable; see `decision-tool.ts`.
          ...(db ? { decisions: buildDecisionToolServer(db, candidate.id) } : {}),
        },
        // PD-432: the ticket's override when it has one, else the loop-wide env default. Null is
        // the normal case, so the global stays authoritative for ~every ticket.
        maxTurns: candidate.maxTurns ?? config.robot.maxTurns,
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
        // PD-964: same posture — a capture failure costs the check evidence, never the session.
        try {
          appendTranscript(transcript, transcriptEntries(message, turnOffset + Math.max(liveTurns, 1)));
        } catch (err) {
          logger.warn({ err, ticketId: candidate.id }, 'robot: transcript capture failed');
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
      // T-902: count DISTINCT `message.id`s, not messages. The stream emits one assistant message
      // per content block, several per turn sharing one id, so counting messages roughly doubled
      // the live number (the "119/100" Steve saw). Read the id defensively: a message with no id
      // falls back to the old per-message count, so an SDK shape change degrades to prior behaviour
      // rather than counting nothing.
      if (message.type === 'assistant' && message.parent_tool_use_id == null) {
        const messageId = (message as { message?: { id?: unknown } }).message?.id;
        let advanced: boolean;
        if (typeof messageId === 'string') {
          advanced = !seenTurnIds.has(messageId);
          if (advanced) seenTurnIds.add(messageId);
        } else {
          advanced = true; // no id to dedupe on — count it, as before
        }
        if (advanced) {
          liveTurns += 1;
          const usage = (message as { message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } } })
            .message?.usage;
          if (usage) {
            const n =
              (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
              (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
            liveTokens = (liveTokens ?? 0) + n;
          }
          try {
            onProgress?.(liveTurns, liveTokens);
          } catch (err) {
            logger.warn({ err, ticketId: candidate.id }, 'robot: turn-progress report failed');
          }
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
  return { ok, sessionId, error, turns, tokens, outputTail: outputTail || undefined, transcript, ...handoff };
}

/**
 * D-094/PD-737: the checkpoint status report.
 *
 * When a run stops at a progress check (PD-964: stalled, off-track, or at the total cap) the loop resumes THE SAME session (`resume: sessionId`, so the
 * agent still remembers everything it did) for a few turns with one instruction: stop and report.
 * The loop drives this, not the agent's own self-tracking, because agents do not reliably count their
 * turns and the ceiling is a hard stop (D-094's rejected alternative).
 *
 * **No code changes, by construction:** the session only has the read-only tools. Telling it "don't
 * edit" is not enough on a step whose whole point is that the tree is about to be saved as-is.
 */
export const STATUS_REPORT_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];
/** Turns the report step may use. Enough to glance at a file it wants to cite; not enough to work. */
export const STATUS_REPORT_MAX_TURNS = 3;
/** Wall-clock bound on the report step, so a hung resume cannot hold the loop's cycle. */
export const STATUS_REPORT_TIMEOUT_MS = 3 * 60_000;

export const STATUS_REPORT_PROMPT = [
  'STOP WORKING. This run has been stopped at a progress check. Do not change any files.',
  '',
  'Your work so far will be saved, and a human will decide whether a new run continues from it or',
  'starts over. Write them a status report, in this shape:',
  '',
  '**Done:** what is implemented and working.',
  '**Left:** what remains to finish the ticket, as concrete steps.',
  '**Blocking:** anything that stopped or slowed you (or "nothing").',
  "**Verify:** the last result of `npm run verify` you saw (or that you hadn't run it).",
  '**Estimate:** how many more turns you think a continuation needs.',
  '',
  'Reply with the report only.',
].join('\n');

export interface StatusReportResult {
  /** The report text, or undefined when the step produced none. */
  report?: string;
  /** Why the step failed, when it did (the loop then falls back to the output tail). */
  error?: string;
}

/**
 * Resume `sessionId` read-only for a short, bounded report. Never throws: any failure (resume not
 * possible, timeout, empty reply) comes back as `{ error }` so the caller can fall back.
 */
export async function runStatusReport(
  config: AgentWorkerConfig,
  candidate: RobotCandidate,
  worktree: Worktree,
  sessionId: string,
  runQuery: RunQuery = query,
  timeoutMs: number = STATUS_REPORT_TIMEOUT_MS,
): Promise<StatusReportResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort('status-report timeout'), timeoutMs);
  let resultText: string | undefined;
  let lastAssistantText = '';
  let error: string | undefined;
  try {
    for await (const message of runQuery({
      prompt: STATUS_REPORT_PROMPT,
      options: {
        model: config.model,
        cwd: worktree.dir,
        resume: sessionId,
        abortController,
        tools: [...STATUS_REPORT_TOOLS],
        maxTurns: STATUS_REPORT_MAX_TURNS,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: codingEnv(config),
        spawnClaudeCodeProcess: makeCodingSpawn(config),
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant' && message.parent_tool_use_id == null) {
        // Keep only text blocks: the report is what the agent SAYS, not the files it read.
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (text) lastAssistantText = text;
        }
      }
      if (message.type === 'result') {
        const r = message as { subtype?: string; is_error?: boolean; result?: unknown; errors?: string[] };
        if (r.subtype === 'success' && !r.is_error && typeof r.result === 'string' && r.result.trim()) {
          resultText = r.result.trim();
        } else if (r.subtype !== 'success') {
          error = (r.errors ?? []).join('; ') || r.subtype;
        }
      }
    }
  } catch (err) {
    error = abortController.signal.aborted ? 'status report timed out' : err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  // A report the agent wrote but whose 3-turn step then hit ITS ceiling is still a report: prefer the
  // result text, else the last thing it said.
  const report = resultText ?? (lastAssistantText || undefined);
  if (report) return { report };
  logger.warn({ ticketId: candidate.id, error }, 'robot: checkpoint status report step produced no report');
  return { error: error ?? 'the report step produced no text' };
}
