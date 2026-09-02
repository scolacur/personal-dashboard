import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { refineSystemPrompt, type RefineProposal } from '@dashboard/shared';
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
    // PD-618: a hard ceiling on ONE turn. There was none — the Robot has capped every run since
    // PD-432, and Refine's use of `robot.maxTurns` below is unrelated: that value goes into the
    // system prompt so the agent can ESTIMATE a ticket's ceiling, which reads like a cap and is not
    // one. Without this a single turn is unbounded, and the SDK reports hitting the cap as an error
    // result — which `resultFrom` already marks `ok: false`, so it lands on the existing failure
    // path rather than being persisted as the agent's words.
    maxTurns: config.refineMaxTurns,
    systemPrompt: refineSystemPrompt(contextPack, config.robot.maxTurns),
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
