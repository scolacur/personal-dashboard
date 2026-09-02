import type Database from 'better-sqlite3';
import type { RefineProposal, TicketEvent } from '@dashboard/shared';
import { REFINE_EVENT_TYPE, REFINE_PROPOSAL_EVENT, refineThreadFromEvents } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import {
  openWarmSession,
  type RefineSession,
  type RefineTurnResult,
  type OpenRefineSession,
  type OpenSessionInput,
} from './session';
import { logger } from '../../shared/logger';
import { classifyFault, SESSION_LIMIT_FALLBACK_MS, SESSION_LIMIT_SIGNATURE } from '../robot/faults';
import { activeSessionLimitHold, holdForSessionLimit } from '../robot/state';

/**
 * The agent-worker's Refine loop (D-044, PD-267). Transport between the web app and this
 * worker is the SHARED SQLite DB — not HTTP: the web writes human turns as
 * `refine_human` events (POST /tickets/:id/refine-reply), this worker polls for them,
 * runs a refine turn, and writes the reply back as a `refine_agent` event plus an
 * `agent_refine` notification. The Claude Agent SDK session id is persisted IN the
 * agent turn's detail, so `resume` survives a worker restart with no separate table.
 *
 * PD-268 adds the "Refine" button (which writes the kickoff `refine_human` = the ticket
 * body) and a warm in-memory session for snappier turns; this slice is the durable,
 * restart-safe cold path.
 */

// ── Pure decision logic (no DB / no SDK — unit-tested directly) ───────────────

export interface RefineWork {
  /** The human turn(s) to send the agent — every human message since the last agent turn. */
  prompt: string;
  /** SDK session to resume; undefined on the first turn of a thread. */
  resumeSessionId?: string;
}

/**
 * Decide the next agent-worker turn for a ticket from its full activity log, or `null` if the
 * agent is already caught up (newest refine event is an agent turn, or there are no human
 * turns at all). The prompt is every human turn AFTER the last agent turn, joined — so a
 * burst of replies before the worker wakes is handled in one turn; resume is the newest
 * agent turn's persisted sessionId.
 */
export function nextRefineWork(events: TicketEvent[]): RefineWork | null {
  const refine = events.filter(
    (e) => e.type === REFINE_EVENT_TYPE.human || e.type === REFINE_EVENT_TYPE.agent,
  );
  if (refine.length === 0) return null;

  let lastAgentIdx = -1;
  for (let i = refine.length - 1; i >= 0; i--) {
    if (refine[i].type === REFINE_EVENT_TYPE.agent) {
      lastAgentIdx = i;
      break;
    }
  }

  const pending = refine.slice(lastAgentIdx + 1); // all human turns (nothing after last agent)
  if (pending.length === 0) return null;

  const prompt = refineThreadFromEvents(pending)
    .map((m) => m.text)
    .filter((t) => t.trim() !== '')
    .join('\n\n')
    .trim();
  if (prompt === '') return null;

  const resumeSessionId =
    lastAgentIdx >= 0
      ? (refine[lastAgentIdx].detail as { sessionId?: string } | null)?.sessionId
      : undefined;

  return { prompt, resumeSessionId };
}

/**
 * True when a turn failed because the resume target no longer exists. The SDK's session store
 * is per-container and not on a persistent volume, so a rebuild/restart invalidates every
 * persisted sessionId — resuming one then fails with "No conversation found with session ID".
 */
export function isStaleSessionError(errorText: string): boolean {
  return /no conversation found with session id/i.test(errorText);
}

/**
 * Rebuild the whole Refine conversation as a single prompt for a FRESH session — used when a
 * resume fails (the prior SDK session was lost). The DB thread is the source of truth, so we
 * replay it and ask the agent to continue from the latest message.
 */
export function fullThreadPrompt(events: TicketEvent[]): string {
  const lines = refineThreadFromEvents(events)
    .filter((m) => m.text.trim() !== '')
    .map((m) => `${m.role === 'human' ? 'Steve' : 'You (earlier)'}: ${m.text}`);
  return [
    'Continuing an earlier Refine conversation whose live session was lost; the transcript so far:',
    '',
    ...lines,
    '',
    'Continue from here — respond to the latest message.',
  ].join('\n');
}

// ── Shared-DB access (mirrors the server's agent_ticket_events row shape) ─────

interface EventRow {
  id: number;
  ticket_id: number;
  type: string;
  detail: string | null;
  created_at: number;
}

function rowToEvent(row: EventRow): TicketEvent {
  let detail: unknown = null;
  if (row.detail != null) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return { id: row.id, ticketId: row.ticket_id, type: row.type, detail, createdAt: row.created_at };
}

/** A ticket's full activity log, oldest first. */
export function listTicketEvents(db: Database.Database, ticketId: number): TicketEvent[] {
  const rows = db
    .prepare(
      'SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(ticketId) as EventRow[];
  return rows.map(rowToEvent);
}

/** Ticket ids whose newest `refine_human` turn is newer than their newest `refine_agent`
 *  turn — i.e. a human is waiting on the agent. Filtered in SQL to avoid scanning the log. */
export function findPendingRefineTicketIds(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT ticket_id
         FROM agent_ticket_events
        WHERE type IN (?, ?)
        GROUP BY ticket_id
       HAVING MAX(CASE WHEN type = ? THEN created_at END) >
              COALESCE(MAX(CASE WHEN type = ? THEN created_at END), 0)`,
    )
    .all(
      REFINE_EVENT_TYPE.human,
      REFINE_EVENT_TYPE.agent,
      REFINE_EVENT_TYPE.human,
      REFINE_EVENT_TYPE.agent,
    ) as { ticket_id: number }[];
  return rows.map((r) => r.ticket_id);
}

/** Persist a agent-worker turn as a `refine_agent` event, carrying the SDK session id for resume. */
export function writeRefineAgentTurn(
  db: Database.Database,
  ticketId: number,
  text: string,
  sessionId: string | undefined,
  now: number = Date.now(),
): void {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, REFINE_EVENT_TYPE.agent, JSON.stringify({ text, sessionId }), now);
}

/**
 * Persist a commit proposal the agent emitted via propose_commit (PD-269) as a
 * `refine_proposal` event + notify Steve. Written from the tool handler (synchronously,
 * mid-turn); the server executes it on approval. A fresh proposal supersedes any earlier
 * un-actioned one (latestActionableProposal picks the newest).
 */
export function writeRefineProposal(
  db: Database.Database,
  ticketId: number,
  proposal: RefineProposal,
  now: number = Date.now(),
): void {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, REFINE_PROPOSAL_EVENT.proposal, JSON.stringify(proposal), now);

  const t = db.prepare('SELECT display_id, is_epic FROM agent_tickets WHERE id = ?').get(ticketId) as
    | { display_id: string | null; is_epic: number }
    | undefined;
  // D-058: a decompose on an Epic is reinterpreted as Populate (members, Epic stays open).
  const verb =
    proposal.mode === 'decompose'
      ? t?.is_epic === 1
        ? 'proposed members'
        : 'proposed a split'
      : 'proposed changes';
  const title = `Refine agent ${verb}${t?.display_id ? ` on ${t.display_id}` : ''}`;
  db.prepare(
    'INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('agent_refine', ticketId, title, proposal.rationale ?? null, now);
}

/**
 * Raise an `agent_refine` notification that the agent-worker posted. Uses the same unread-dedup
 * guard the server's createNotification does — one unread notification per ticket at a time,
 * so a back-and-forth doesn't flood the inbox until Steve reads it.
 */
export function notifyRefinePosted(
  db: Database.Database,
  ticketId: number,
  text: string,
  now: number = Date.now(),
): void {
  const dup = db
    .prepare('SELECT 1 FROM agent_notifications WHERE ticket_id = ? AND kind = ? AND read_at IS NULL')
    .get(ticketId, 'agent_refine');
  if (dup) return;

  const t = db.prepare('SELECT display_id FROM agent_tickets WHERE id = ?').get(ticketId) as
    | { display_id: string | null }
    | undefined;
  const title = `Refine agent replied${t?.display_id ? ` on ${t.display_id}` : ''}`;
  const body = text.length > 280 ? `${text.slice(0, 279)}…` : text;
  db.prepare(
    'INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('agent_refine', ticketId, title, body, now);
}

// ── Warm session manager (D-044, PD-268) ─────────────────────────────────────

/**
 * Holds the resident warm refine sessions, one per active ticket (Map<ticketId, session>).
 * A turn reuses the live session (snappy — no subprocess re-spawn / history re-send); the
 * first turn after a restart opens cold, rehydrating the persisted resumeSessionId from the
 * DB. Idle sessions are swept so the worker doesn't hoard subprocesses; a cold turn later
 * simply rehydrates again.
 */
export class WarmSessions {
  private readonly map = new Map<number, RefineSession>();

  constructor(
    private readonly open: OpenRefineSession = openWarmSession,
    /** Evict a session after this long without a turn (default 15 min). */
    private readonly idleMs = 15 * 60_000,
  ) {}

  /** Whether a warm session is already resident for this ticket. */
  has(ticketId: number): boolean {
    return this.map.has(ticketId);
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Run a turn, opening a session cold (rehydrating `resumeSessionId`) if none is resident.
   * `resumeSessionId` is honoured ONLY on a cold open — a live session already holds context.
   */
  async turn(ticketId: number, input: OpenSessionInput, prompt: string): Promise<RefineTurnResult> {
    let session = this.map.get(ticketId);
    if (!session) {
      session = this.open(input);
      this.map.set(ticketId, session);
    }
    return session.send(prompt);
  }

  /** Close + forget a ticket's session so the next turn opens a fresh one (used when a
   *  resume target is stale — the old session is dead anyway). */
  reset(ticketId: number): void {
    const session = this.map.get(ticketId);
    if (session) {
      void session.close();
      this.map.delete(ticketId);
    }
  }

  /** Close + drop sessions idle longer than `idleMs`. Returns the count evicted. */
  sweep(now = Date.now()): number {
    let evicted = 0;
    for (const [ticketId, session] of this.map) {
      if (now - session.lastUsedAt > this.idleMs) {
        void session.close();
        this.map.delete(ticketId);
        evicted++;
      }
    }
    if (evicted > 0) logger.info({ evicted, remaining: this.map.size }, 'refine: swept idle sessions');
    return evicted;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.map.values()].map((s) => s.close()));
    this.map.clear();
  }
}

/**
 * Per-ticket retry spacing for failed turns (PD-618).
 *
 * A failed turn is left pending so it self-heals on a later poll — right, and the reason this is
 * spacing rather than an attempt cap. What was wrong is that "a later poll" meant **5 seconds**
 * (`refineIntervalMs`), with no backoff: on 2026-09-01 a single turn that could not succeed was
 * retried from 01:55 until the worker was stopped the next morning.
 *
 * Exponential from 30s to a 30-minute ceiling: roughly 20 attempts over 8 hours instead of ~6,000,
 * while still recovering on its own once the cause clears.
 *
 * Deliberately NO give-up threshold. The whole point of leaving a turn pending is that the human
 * should not have to re-send a reply once credits are topped up or a limit rolls over, and a ticket
 * that stopped retrying forever would need exactly that. Bounding the RATE fixes the incident;
 * bounding the COUNT would break the recovery.
 *
 * In-memory, so a restart retries immediately. That is the desired behaviour — restarting the worker
 * is a deliberate act and usually means the operator has fixed something.
 */
export class RefineBackoff {
  private readonly failures = new Map<number, { count: number; nextAttemptAt: number }>();

  constructor(
    private readonly baseMs = 30_000,
    private readonly maxMs = 30 * 60_000,
  ) {}

  /** Whether this ticket may be attempted now. */
  ready(ticketId: number, now: number = Date.now()): boolean {
    const entry = this.failures.get(ticketId);
    return entry === undefined || now >= entry.nextAttemptAt;
  }

  /** Record a failed turn and return when the next attempt is allowed. */
  recordFailure(ticketId: number, now: number = Date.now()): { attempt: number; waitMs: number } {
    const count = (this.failures.get(ticketId)?.count ?? 0) + 1;
    const waitMs = Math.min(this.baseMs * 2 ** (count - 1), this.maxMs);
    this.failures.set(ticketId, { count, nextAttemptAt: now + waitMs });
    return { attempt: count, waitMs };
  }

  /** Forget a ticket's history — called on a clean turn, so recovery is immediate. */
  clear(ticketId: number): void {
    this.failures.delete(ticketId);
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ProcessDeps {
  /** The warm-session pool. Pass a long-lived instance so warmth survives across cycles;
   *  a fresh (cold-every-time) one is created if omitted. */
  sessions?: WarmSessions;
  /** Per-ticket retry spacing (PD-618). Pass a long-lived instance so backoff survives cycles. */
  backoff?: RefineBackoff;
  /** Injectable for tests; defaults to reading the grounding checkout. */
  buildContext?: (checkoutDir: string, onMissing?: (what: string) => void) => string;
  /** Injectable clock for the written event/notification timestamps (tests want it monotonic). */
  now?: () => number;
}

/**
 * One poll cycle: find tickets awaiting the agent, run a (warm-if-resident) refine turn for
 * each, and write the reply + notification back to the shared DB. Returns how many turns were
 * posted. A failed or empty turn is logged and left pending (retried next cycle) rather than
 * writing a bogus agent turn. Tickets are processed sequentially, so a session never has two
 * concurrent turns in flight.
 */
export async function processPendingRefines(
  db: Database.Database,
  config: AgentWorkerConfig,
  deps: ProcessDeps = {},
): Promise<number> {
  const sessions = deps.sessions ?? new WarmSessions();
  const backoff = deps.backoff ?? new RefineBackoff();
  const buildContext = deps.buildContext ?? buildContextPack;
  const now = deps.now ?? Date.now;

  // PD-618: the provider's quota is one quota. A session limit hit by the Robot or by Refine stops
  // both, using the hold the Robot already maintains (PD-470) rather than a second mechanism — and
  // `activeSessionLimitHold` self-clears once the stated reset passes, so this resumes with no human
  // action. Refine had no hold at all, so a limit that parked the Robot left Refine retrying into it.
  const hold = activeSessionLimitHold(db, now());
  if (hold) return 0;

  const ticketIds = findPendingRefineTicketIds(db).filter((id) => backoff.ready(id, now()));
  if (ticketIds.length === 0) return 0;

  const contextPack = buildContext(config.checkoutDir, (what) =>
    logger.warn({ what }, 'refine: context pack is missing an expected section — the agent runs degraded'),
  );
  let handled = 0;

  for (const ticketId of ticketIds) {
    const events = listTicketEvents(db, ticketId);
    const work = nextRefineWork(events);
    if (!work) continue;
    const warm = sessions.has(ticketId);
    // The agent calls propose_commit → we persist the proposal for Steve to approve.
    const onProposal = (proposal: RefineProposal) => writeRefineProposal(db, ticketId, proposal, now());
    try {
      let result = await sessions.turn(
        ticketId,
        { config, contextPack, resumeSessionId: work.resumeSessionId, onProposal },
        work.prompt,
      );
      // Stale resume: the SDK's session store is per-container and not persisted, so a rebuild
      // invalidates the sessionId we saved. Drop the dead session and retry ONCE fresh, replaying
      // the whole thread as context — self-healing instead of wedging the ticket forever.
      if (!result.ok && work.resumeSessionId && isStaleSessionError(result.text)) {
        logger.warn({ ticketId, staleSessionId: work.resumeSessionId }, 'refine: resume session gone — retrying fresh');
        sessions.reset(ticketId);
        result = await sessions.turn(
          ticketId,
          { config, contextPack, resumeSessionId: undefined, onProposal },
          fullThreadPrompt(events),
        );
      }
      if (!result.ok) {
        // An API/agent error (billing, rate limit, auth, max-turns) — NOT the agent's words.
        // Log the real reason and leave the ticket pending so it self-heals on a later poll
        // (e.g. once credits are topped up) without needing a fresh human reply.
        //
        // PD-618: what was missing is that "a later poll" was 5 seconds away, forever. Classify the
        // fault with the Robot's own classifier: a session limit takes the shared hold (stopping
        // every ticket, since the quota is shared), and anything else backs this ticket off.
        const fault = classifyFault({ verifyOk: false, error: result.text }, now());
        if (fault.signature === SESSION_LIMIT_SIGNATURE) {
          const until = fault.resetAt ?? now() + SESSION_LIMIT_FALLBACK_MS;
          holdForSessionLimit(db, until, fault.reason, now());
          logger.warn({ ticketId, until, reason: fault.reason }, 'refine: session limit — holding all refine turns');
          return handled;
        }
        const { attempt, waitMs } = backoff.recordFailure(ticketId, now());
        logger.warn(
          { ticketId, attempt, waitMs, error: result.text.slice(0, 300) },
          'refine: turn errored — backing off, will retry',
        );
        continue;
      }
      if (result.text.trim() === '') {
        const { attempt, waitMs } = backoff.recordFailure(ticketId, now());
        logger.warn({ ticketId, attempt, waitMs }, 'refine: empty turn — backing off, will retry');
        continue;
      }
      const ts = now();
      backoff.clear(ticketId);
      writeRefineAgentTurn(db, ticketId, result.text, result.sessionId, ts);
      notifyRefinePosted(db, ticketId, result.text, ts);
      handled++;
      logger.info(
        { ticketId, warm, cacheReadTokens: result.cacheReadTokens, durationMs: result.durationMs },
        'refine: posted turn',
      );
    } catch (err) {
      const { attempt, waitMs } = backoff.recordFailure(ticketId, now());
      logger.error({ err, ticketId, attempt, waitMs }, 'refine: turn failed — backing off');
    }
  }

  return handled;
}
