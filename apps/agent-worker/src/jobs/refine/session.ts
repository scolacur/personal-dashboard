import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  HookCallbackMatcher,
  HookJSONOutput,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  refineSystemPrompt,
  REFINE_TURN_ESTIMATE_FLOOR,
  type RefineProposal,
  type RefineQuestionRound,
} from '@dashboard/shared';
import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { ASK_TOOL_NAME } from './ask-tool';
import { BOARD_TOOL_NAMES } from './board-tools';
import { buildProposeToolServer, PROPOSE_TOOL_NAME } from './propose-tool';

/** Read-only built-in tools — the agent-worker grounds against the checkout, never edits. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

// ── Sub-agents (PD-844) ──────────────────────────────────────────────────────

/**
 * The sub-agent spawn tool. Its canonical name is `Agent`; `Task` is the legacy name the CLI still
 * maps onto it (the SDK's alias table: `{Task:"Agent", ...}` in sdk.mjs), so both are matched. The
 * input shape is `AgentInput` in sdk-tools.d.ts: `subagent_type?`, `run_in_background?` ("Agents run
 * in the background by default"), `isolation?` ("remote" always runs in the background), `mode?`.
 */
export const AGENT_TOOL_NAMES = ['Agent', 'Task'] as const;

/** The only sub-agent type Refine may spawn. */
export const REFINE_EXPLORER_AGENT = 'refine-explorer';

/**
 * Tools Refine must never have. `allowedTools` only auto-approves; it does not limit which tools
 * exist, so without this the model saw the full Claude Code toolset. These are removed from the
 * model's context entirely ("removed from the model's context and cannot be used", Options in
 * sdk.d.ts). The second group is every task/background-control tool other than Agent: with
 * sub-agents forced into the foreground there is nothing to poll, stop, message or wake up for, and
 * a scheduled wake-up would recreate exactly the "turn ends, result arrives later" shape PD-844
 * removes.
 */
export const REFINE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'Monitor',
  'SendMessage',
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'Workflow',
  'EnterWorktree',
  'ExitWorktree',
];

/** The explorer's definition: read-only grounding plus the read-only board, and nothing that can
 *  ask Steve or record a proposal (those stay with the Refine agent itself). */
export function refineExplorerAgent(boardTools: readonly string[]): AgentDefinition {
  return {
    description:
      'Read-only explorer for wide searches of the grounding checkout and the board. Returns its findings in the same turn.',
    tools: [...READ_ONLY_TOOLS, ...boardTools],
    background: false,
    prompt: [
      'You are an explorer working for the Refine agent of the Personal Dashboard board. You get one',
      'self-contained brief; answer it and stop. Your final message is your whole report, so put every',
      'finding in it, with file paths and line numbers or ticket ids and titles.',
      '',
      'What you can see:',
      '- The grounding checkout (your working directory) at `main`, refreshed about every 5 minutes,',
      '  through Read, Grep and Glob.',
      boardTools.length > 0
        ? '- The live board, read-only, through search_tickets, get_ticket, list_relations and list_epic_members.'
        : '- (The board tools are not available in this session.)',
      '',
      'What you cannot see: unmerged pull requests or branches, deploy or runtime state, and git',
      'history. If the brief depends on one of those, say so plainly instead of guessing. You only',
      'read; you never write, ask questions, or propose changes.',
    ].join('\n'),
  };
}

/**
 * PreToolUse hook that keeps Refine's sub-agents in the foreground and restricted to the explorer.
 *
 * Why a PreToolUse hook and not `canUseTool`: `canUseTool` is only consulted on the permission
 * "ask" path. Under `permissionMode: 'dontAsk'` that path is auto-denied without ever reaching the
 * host (sdk.d.ts, SDKPermissionDeniedMessage: "auto-denied without an interactive permission
 * prompt (e.g. ... dontAsk mode ...). The 'ask' path surfaces via a can_use_tool control_request"),
 * and a tool already approved — by `allowedTools`, or the Agent tool's own permission check, which is
 * how background explorers ran on PD-284 and PD-799 with Agent in neither list — never asks at all.
 * So a `canUseTool` here would never be called. PreToolUse hooks run for every tool call before the
 * permission decision (the same typings note that "PreToolUse hook denies bypass canUseTool"), and
 * `PreToolUseHookSpecificOutput` carries both `permissionDecision` and `updatedInput`, which is what
 * forcing `run_in_background: false` needs.
 *
 * Every other tool gets `{}` (no decision), leaving the existing permission behaviour unchanged.
 */
export async function refineAgentToolHook(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse' || !AGENT_TOOL_NAMES.includes(input.tool_name as (typeof AGENT_TOOL_NAMES)[number])) {
    return {};
  }
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  if (toolInput.subagent_type !== REFINE_EXPLORER_AGENT) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Refine may only spawn the ${REFINE_EXPLORER_AGENT} sub-agent. Set subagent_type: "${REFINE_EXPLORER_AGENT}" and give it a self-contained brief.`,
      },
    };
  }
  // `isolation: 'remote'` always runs in the background and `mode` is a teammate setting; neither has
  // a place in a read-only foreground explorer, so both are dropped rather than trusted.
  const { isolation: _isolation, mode: _mode, ...rest } = toolInput;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Refine explorers run in the foreground (PD-844).',
      updatedInput: { ...rest, run_in_background: false },
    },
  };
}

const REFINE_HOOKS: { PreToolUse: HookCallbackMatcher[] } = {
  PreToolUse: [{ matcher: AGENT_TOOL_NAMES.join('|'), hooks: [refineAgentToolHook] }],
};

export interface RefineTurnInput {
  config: AgentWorkerConfig;
  /** Compact, cached project-context prefix (glossary + building-block index). */
  contextPack: string;
  /** The human turn: the ticket body on the first turn, or a reply afterwards. */
  prompt: string;
  /** Resume a prior refine session (async follow-up); omit to start fresh. */
  resumeSessionId?: string;
  /** Called when the agent invokes propose_commit (PD-269); records the commit proposal. */
  onProposal?: (proposal: RefineProposal) => void;
  /** PD-634: the ticket is an Epic, so a decompose is a Populate and must carry the Epic's body. */
  targetIsEpic?: boolean;
  /** PD-744: called when the agent invokes ask_questions; stages the round for this turn. A warm
   *  session binds this once, on open, so it must not close over per-turn state. */
  onRound?: (round: RefineQuestionRound) => void;
  /** PD-433: the worker's DB handle, which exposes the read-only board tools. */
  db?: Database.Database;
}

export interface RefineTurnResult {
  /** The assistant reply on success, or the error text when `ok` is false (for logging). */
  text: string;
  /** True only for a clean turn (result subtype 'success' AND not is_error). False for API
   *  errors — billing ("credit balance too low"), rate limits, max-turns, etc. — which the SDK
   *  reports as an error result the caller must NOT persist as an agent turn (D-044). */
  ok: boolean;
  sessionId: string | undefined;
  /** Cached input tokens the turn read — the warmth signal (D-044, PD-268 Done-When #2). */
  cacheReadTokens?: number;
  /** End-to-end turn latency reported by the SDK. */
  durationMs?: number;
}

/** Project an SDK result message into our turn shape, distinguishing a clean reply from an
 *  error result (billing/rate-limit/max-turns). On error `ok` is false and `text` carries the
 *  error(s) so the loop can log why without persisting it as the agent's words. */
function resultFrom(message: Extract<SDKMessage, { type: 'result' }>): RefineTurnResult {
  const ok = message.subtype === 'success' && !message.is_error;
  const text = message.subtype === 'success' ? message.result : (message.errors ?? []).join('; ');
  return {
    text,
    ok,
    sessionId: message.session_id,
    cacheReadTokens: message.usage?.cache_read_input_tokens,
    durationMs: message.duration_ms,
  };
}

/** The SDK options shared by the one-shot and warm-streaming paths. When `onProposal` is
 *  given, the propose_commit tool (PD-269) is exposed and allowed alongside the read-only set;
 *  `onRound` adds ask_questions (PD-744). Exported for its tests. */
export function refineOptions(
  config: AgentWorkerConfig,
  contextPack: string,
  resumeSessionId?: string,
  onProposal?: (proposal: RefineProposal) => void,
  targetIsEpic?: boolean,
  onRound?: (round: RefineQuestionRound) => void,
  db?: Database.Database,
) {
  const boardTools: readonly string[] = onProposal && db ? BOARD_TOOL_NAMES : [];
  const refineTools = onProposal ? [PROPOSE_TOOL_NAME, ...(onRound ? [ASK_TOOL_NAME] : []), ...boardTools] : [];
  return {
    model: config.model,
    cwd: config.checkoutDir,
    // PD-618: a hard ceiling on ONE turn. There was none — the Robot has capped every run since
    // PD-432, and Refine's use of `robot.maxTurns` below is unrelated: that value goes into the
    // system prompt so the agent can ESTIMATE a ticket's ceiling, which reads like a cap and is not
    // one. Without this a single turn is unbounded, and the SDK reports hitting the cap as an error
    // result — which `resultFrom` already marks `ok: false`, so it lands on the existing failure
    // path rather than being persisted as the agent's words.
    maxTurns: config.refineMaxTurns,
    systemPrompt: refineSystemPrompt(contextPack, config.robot.maxTurns, REFINE_TURN_ESTIMATE_FLOOR),
    // `Agent` is listed so spawning the explorer is approved by rule, independent of the hook's
    // `allow`; the hook below still rewrites its input and refuses any other sub-agent type.
    allowedTools: [...READ_ONLY_TOOLS, 'Agent', ...refineTools],
    disallowedTools: REFINE_DISALLOWED_TOOLS,
    // Headless: deny any tool outside the allowlist without prompting (would hang).
    permissionMode: 'dontAsk' as const,
    // PD-844: sub-agents only as the read-only explorer, and only in the foreground.
    agents: { [REFINE_EXPLORER_AGENT]: refineExplorerAgent(boardTools) },
    hooks: REFINE_HOOKS,
    ...(onProposal ? { mcpServers: { refine: buildProposeToolServer(onProposal, { targetIsEpic, onRound, board: db }) } } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Run ONE refine turn via a fresh Agent SDK query (D-044). Opus, grounded in the read-only
 * checkout, read-only tools. Spawns a subprocess per call — used for cold one-shots and the
 * smoke script. The warm path (openWarmSession) keeps the process resident between turns.
 */
export async function runRefineTurn(input: RefineTurnInput): Promise<RefineTurnResult> {
  // Defaults to a non-ok, empty result — so if no result message ever arrives (a hard
  // failure), the caller treats it as an errored turn rather than a bogus empty success.
  let result: RefineTurnResult = { text: '', ok: false, sessionId: undefined };

  for await (const message of query({
    prompt: input.prompt,
    options: refineOptions(
      input.config,
      input.contextPack,
      input.resumeSessionId,
      input.onProposal,
      input.targetIsEpic,
      input.onRound,
      input.db,
    ),
  })) {
    if (message.type === 'result') result = resultFrom(message);
  }

  return result;
}

// ── Warm streaming session (D-044, PD-268) ───────────────────────────────────

/**
 * A live refine session held resident between turns. Backed by a single streaming-input
 * `query()`: the `claude` subprocess and the model's in-session context stay warm, so
 * back-and-forth turns skip subprocess re-spawn and full-history re-send — snappier than
 * a cold `runRefineTurn` per turn. Created cold from a persisted `resumeSessionId` after a
 * worker restart, then warm for the rest of the conversation.
 */
export interface RefineSession {
  /** Send one human turn; resolves with the agent's reply on the next result message. */
  send(prompt: string): Promise<RefineTurnResult>;
  /** End the input stream and interrupt the query. */
  close(): Promise<void>;
  /** The SDK session id (known after the first turn). */
  readonly sessionId: string | undefined;
  /** Unix ms of the last send — the idle-evict clock. */
  lastUsedAt: number;
}

export interface OpenSessionInput {
  config: AgentWorkerConfig;
  contextPack: string;
  /** Rehydrate a prior session (cold start after a restart); omit for a brand-new thread. */
  resumeSessionId?: string;
  /** Called when the agent invokes propose_commit (PD-269); records the commit proposal. */
  onProposal?: (proposal: RefineProposal) => void;
  /** PD-634: the ticket is an Epic, so a decompose is a Populate and must carry the Epic's body. */
  targetIsEpic?: boolean;
  /** PD-744: called when the agent invokes ask_questions; stages the round for this turn. A warm
   *  session binds this once, on open, so it must not close over per-turn state. */
  onRound?: (round: RefineQuestionRound) => void;
  /** PD-433: the worker's DB handle, which exposes the read-only board tools. */
  db?: Database.Database;
}

/** Factory type so the warm-session manager and its tests can swap the real SDK out. */
export type OpenRefineSession = (input: OpenSessionInput) => RefineSession;

/** A push-driven AsyncIterable of user messages that stays open until `end()`. */
function createInputStream() {
  const queued: SDKUserMessage[] = [];
  let pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let ended = false;

  const stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queued.length > 0) return Promise.resolve({ value: queued.shift()!, done: false });
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => (pending = resolve));
        },
      };
    },
  };

  return {
    stream,
    push(msg: SDKUserMessage) {
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: msg, done: false });
      } else {
        queued.push(msg);
      }
    },
    end() {
      ended = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: undefined as never, done: true });
      }
    },
  };
}

/**
 * Open a warm streaming refine session. Turns are strictly sequential (Steve replies one at a
 * time), so a single in-flight `send` is tracked; the background consumer resolves it on the
 * next `result` message and accumulates that turn's assistant text.
 */
interface PendingTurn {
  resolve: (r: RefineTurnResult) => void;
  reject: (e: unknown) => void;
}

export const openWarmSession: OpenRefineSession = (input) => {
  const input$ = createInputStream();
  let sessionId: string | undefined = input.resumeSessionId;
  // The idle-evict clock, held here rather than on `session` because the drain loop below stamps it
  // and is declared first. Exposed through accessors so `RefineSession.lastUsedAt` stays a plain
  // mutable property to its callers.
  let lastUsedAt = Date.now();
  // The single in-flight turn (turns are strictly sequential), or null when idle. Consumed
  // via the helpers below so the read happens at the declared union type (TS would otherwise
  // narrow it to `null` inside the drain loop, since `send` reassigns it further down).
  let pending: PendingTurn | null = null;
  const settleTurn = (result: RefineTurnResult) => {
    const turn = pending;
    pending = null;
    turn?.resolve(result);
  };
  const failTurn = (err: unknown) => {
    const turn = pending;
    pending = null;
    turn?.reject(err);
  };

  const q = query({
    prompt: input$.stream,
    options: refineOptions(
      input.config,
      input.contextPack,
      input.resumeSessionId,
      input.onProposal,
      input.targetIsEpic,
      input.onRound,
      input.db,
    ),
  });

  // Drain the query in the background, routing each completed turn back to its `send` caller.
  void (async () => {
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        if (message.type === 'result') {
          const turn = resultFrom(message);
          sessionId = turn.sessionId;
          // PD-618: re-stamp on COMPLETION. It was only set when a turn was SENT, so it measured
          // "time since this turn started" — while the idle sweep reads it as "time since this
          // session was last busy". A turn outliving the idle window was therefore swept *while
          // running*, which is what made the hang in `close()` reachable.
          lastUsedAt = Date.now();
          settleTurn(turn);
        }
      }
    } catch (err) {
      failTurn(err);
    }
  })();

  const session: RefineSession = {
    get sessionId() {
      return sessionId;
    },
    get lastUsedAt() {
      return lastUsedAt;
    },
    set lastUsedAt(value: number) {
      lastUsedAt = value;
    },
    send(prompt: string): Promise<RefineTurnResult> {
      lastUsedAt = Date.now();
      return new Promise<RefineTurnResult>((resolve, reject) => {
        pending = { resolve, reject };
        input$.push(userMessage(prompt));
      });
    },
    async close(): Promise<void> {
      // PD-618: settle any in-flight turn FIRST.
      //
      // `close()` ends the input stream and interrupts the query, so the drain loop above exits
      // without ever seeing a `result` message — meaning neither `settleTurn` nor `failTurn` ran and
      // the caller's `await session.send(...)` hung forever. In `processPendingRefines` that `await`
      // is inside the poll cycle's re-entrancy guard, so one hung turn wedged the ENTIRE Refine job
      // until the worker restarted. The idle sweep calls `close()` on a live session by design, so
      // this was reachable on any turn that outlived the 15-minute idle window.
      //
      // Reported as a failed turn rather than a rejection: it is exactly the shape of every other
      // unusable turn, so it takes the existing "log it and leave the ticket pending" path instead
      // of needing its own.
      settleTurn({ text: 'refine session closed before the turn completed', ok: false, sessionId });
      input$.end();
      try {
        await q.interrupt();
      } catch {
        // already finished / not in streaming state — nothing to interrupt
      }
    },
  };

  return session;
};
