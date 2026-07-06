import type Database from 'better-sqlite3';
import type { TicketEvent } from '@dashboard/shared';
import { REFINE_EVENT_TYPE, refineThreadFromEvents } from '@dashboard/shared';
import type { GrillerConfig } from './config';
import { buildContextPack } from './context-pack';
import {
  openWarmSession,
  type GrillSession,
  type GrillTurnResult,
  type OpenGrillSession,
  type OpenSessionInput,
} from './session';
import { logger } from './logger';

/**
 * The griller's Refine loop (D-044, PD-267). Transport between the web app and this
 * worker is the SHARED SQLite DB — not HTTP: the web writes human turns as
 * `refine_human` events (POST /tickets/:id/refine-reply), this worker polls for them,
 * runs a grill turn, and writes the reply back as a `refine_agent` event plus an
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
 * Decide the next griller turn for a ticket from its full activity log, or `null` if the
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

/** Persist a griller turn as a `refine_agent` event, carrying the SDK session id for resume. */
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
 * Raise an `agent_refine` notification that the griller posted. Uses the same unread-dedup
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
 * Holds the resident warm grill sessions, one per active ticket (Map<ticketId, session>).
 * A turn reuses the live session (snappy — no subprocess re-spawn / history re-send); the
 * first turn after a restart opens cold, rehydrating the persisted resumeSessionId from the
 * DB. Idle sessions are swept so the worker doesn't hoard subprocesses; a cold turn later
 * simply rehydrates again.
 */
export class WarmSessions {
  private readonly map = new Map<number, GrillSession>();

  constructor(
    private readonly open: OpenGrillSession = openWarmSession,
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
  async turn(ticketId: number, input: OpenSessionInput, prompt: string): Promise<GrillTurnResult> {
    let session = this.map.get(ticketId);
    if (!session) {
      session = this.open(input);
      this.map.set(ticketId, session);
    }
    return session.send(prompt);
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

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ProcessDeps {
  /** The warm-session pool. Pass a long-lived instance so warmth survives across cycles;
   *  a fresh (cold-every-time) one is created if omitted. */
  sessions?: WarmSessions;
  /** Injectable for tests; defaults to reading the grounding checkout. */
  buildContext?: (checkoutDir: string) => string;
  /** Injectable clock for the written event/notification timestamps (tests want it monotonic). */
  now?: () => number;
}

/**
 * One poll cycle: find tickets awaiting the agent, run a (warm-if-resident) grill turn for
 * each, and write the reply + notification back to the shared DB. Returns how many turns were
 * posted. A failed or empty turn is logged and left pending (retried next cycle) rather than
 * writing a bogus agent turn. Tickets are processed sequentially, so a session never has two
 * concurrent turns in flight.
 */
export async function processPendingRefines(
  db: Database.Database,
  config: GrillerConfig,
  deps: ProcessDeps = {},
): Promise<number> {
  const sessions = deps.sessions ?? new WarmSessions();
  const buildContext = deps.buildContext ?? buildContextPack;
  const now = deps.now ?? Date.now;

  const ticketIds = findPendingRefineTicketIds(db);
  if (ticketIds.length === 0) return 0;

  const contextPack = buildContext(config.checkoutDir);
  let handled = 0;

  for (const ticketId of ticketIds) {
    const work = nextRefineWork(listTicketEvents(db, ticketId));
    if (!work) continue;
    const warm = sessions.has(ticketId);
    try {
      const result = await sessions.turn(
        ticketId,
        { config, contextPack, resumeSessionId: work.resumeSessionId },
        work.prompt,
      );
      if (result.text.trim() === '') {
        logger.warn({ ticketId }, 'refine: empty turn — leaving pending, will retry');
        continue;
      }
      const ts = now();
      writeRefineAgentTurn(db, ticketId, result.text, result.sessionId, ts);
      notifyRefinePosted(db, ticketId, result.text, ts);
      handled++;
      logger.info(
        { ticketId, warm, cacheReadTokens: result.cacheReadTokens, durationMs: result.durationMs },
        'refine: posted turn',
      );
    } catch (err) {
      logger.error({ err, ticketId }, 'refine: turn failed — leaving pending');
    }
  }

  return handled;
}
