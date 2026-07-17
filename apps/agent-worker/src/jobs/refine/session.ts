import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RefineProposal } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildProposeToolServer, PROPOSE_TOOL_NAME } from './propose-tool';

/** Read-only built-in tools — the agent-worker grounds against the checkout, never edits. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

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

function systemPrompt(contextPack: string): string {
  return [
    'You are the Refine agent for the Personal Dashboard board (see DECISIONS.md D-044).',
    'You work INTERACTIVELY with Steve to sharpen a Prioritized ticket BEFORE any Robot run',
    'is dispatched. Plan first: ask the right number of clarifying questions (err toward more),',
    'always do some up-front planning, and GROUND every claim in the real codebase — use your',
    'read-only Read/Grep/Glob tools against the checkout, and check whether a tool/widget already',
    'exists before proposing new work. You only read, plan, and propose; you never write or edit.',
    '',
    'Sizing guidance: a small change (a design tweak, a simple display component, few files, no',
    'decomposition) is instantly plannable; medium or vague tickets need follow-up questions;',
    'large features (many files, front-end AND back-end, or anything touching critical infra)',
    'warrant a full refinement session.',
    '',
    'When you and Steve have converged on a concrete plan, call the propose_commit tool to',
    'record it (refine-in-place or decompose). You never write tickets yourself — the proposal',
    'is what Steve approves on the board. Refine does NOT dispatch (D-057): never route a ticket',
    'into a queue lane (robot_queue / steve_queue) — set a pre-queue lane (backlog / prioritized)',
    "and let Steve queue it himself after approving. A ticket you intend for the robot MUST still",
    'carry the four sections (## Context, ## Task, ## Done When, ## Out of scope) so it is ready to',
    'queue as-is. Do not propose prematurely.',
    '',
    'Project context:',
    contextPack,
  ].join('\n');
}

/** The SDK options shared by the one-shot and warm-streaming paths. When `onProposal` is
 *  given, the propose_commit tool (PD-269) is exposed and allowed alongside the read-only set. */
function refineOptions(
  config: AgentWorkerConfig,
  contextPack: string,
  resumeSessionId?: string,
  onProposal?: (proposal: RefineProposal) => void,
) {
  return {
    model: config.model,
    cwd: config.checkoutDir,
    systemPrompt: systemPrompt(contextPack),
    allowedTools: onProposal ? [...READ_ONLY_TOOLS, PROPOSE_TOOL_NAME] : READ_ONLY_TOOLS,
    // Headless: deny any tool outside the allowlist without prompting (would hang).
    permissionMode: 'dontAsk' as const,
    ...(onProposal ? { mcpServers: { refine: buildProposeToolServer(onProposal) } } : {}),
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
    options: refineOptions(input.config, input.contextPack, input.resumeSessionId, input.onProposal),
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
    options: refineOptions(input.config, input.contextPack, input.resumeSessionId, input.onProposal),
  });

  // Drain the query in the background, routing each completed turn back to its `send` caller.
  void (async () => {
    try {
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        if (message.type === 'result') {
          const turn = resultFrom(message);
          sessionId = turn.sessionId;
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
    lastUsedAt: Date.now(),
    send(prompt: string): Promise<RefineTurnResult> {
      session.lastUsedAt = Date.now();
      return new Promise<RefineTurnResult>((resolve, reject) => {
        pending = { resolve, reject };
        input$.push(userMessage(prompt));
      });
    },
    async close(): Promise<void> {
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
