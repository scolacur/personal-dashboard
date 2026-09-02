import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { RefineProposal, TicketEvent } from '@dashboard/shared';
import { REFINE_EVENT_TYPE, REFINE_PROPOSAL_EVENT } from '@dashboard/shared';
import { type AgentWorkerConfig, loadRobotConfig, loadEvaluatorConfig, loadMaintenanceConfig } from '../../shared/config';
import type { RefineSession, RefineTurnResult, OpenRefineSession, OpenSessionInput } from './session';
import {
  nextRefineWork,
  findPendingRefineTicketIds,
  listTicketEvents,
  processPendingRefines,
  writeRefineProposal,
  RefineBackoff,
  WarmSessions,
} from './refine';
import { ensureRobotStateTable, sessionLimitHold, holdForSessionLimit } from '../robot/state';

// Minimal slice of the shared dashboard schema the agent-worker touches (the web app owns the
// canonical schema; the agent-worker only reads/writes these three tables).
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL,
      is_epic INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agent_ticket_events (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL,
      detail TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_notifications (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER,
      title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
  // PD-618: mirrors `startRefineJob`, which ensures this table because Refine reads the shared
  // session-limit hold and must not depend on the Robot job having started.
  ensureRobotStateTable(db);
  return db;
}

let seq = 0;
function addTicket(db: Database.Database, id: number, displayId: string, isEpic = false): void {
  db.prepare('INSERT INTO agent_tickets (id, display_id, title, is_epic) VALUES (?, ?, ?, ?)').run(
    id,
    displayId,
    't',
    isEpic ? 1 : 0,
  );
}
function addEvent(db: Database.Database, ticketId: number, type: string, detail: unknown): void {
  // Monotonic created_at so ordering is deterministic regardless of clock resolution.
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
    ++seq,
  );
}

const CONFIG: AgentWorkerConfig = {
  model: 'claude-opus-4-8',
  githubRepo: 'x/y',
  githubReadToken: '',
  checkoutDir: '/co',
  dataDir: '/data',
  pullIntervalMs: 1,
  refineIntervalMs: 1,
  refineMaxTurns: 30,
  auditIntervalMs: 1,
  httpsProxy: '',
  robot: loadRobotConfig({}),
  evaluator: loadEvaluatorConfig({}),
  maintenance: loadMaintenanceConfig({}),
};

/** A fake session factory: records every open() + send(), returns canned replies. Each open
 *  models a fresh subprocess; a warm reuse sends into an existing fake session (no new open). */
function fakeSessions(reply: string, sessionId = 'sess-1') {
  const opens: OpenSessionInput[] = [];
  const sends: { prompt: string; resumeSessionId?: string }[] = [];
  let closed = 0;
  const open: OpenRefineSession = (input) => {
    opens.push(input);
    let sid = input.resumeSessionId ?? sessionId;
    const session: RefineSession = {
      get sessionId() {
        return sid;
      },
      lastUsedAt: Date.now(),
      async send(prompt: string): Promise<RefineTurnResult> {
        sends.push({ prompt, resumeSessionId: input.resumeSessionId });
        sid = sessionId;
        return { text: reply, ok: true, sessionId: sid, cacheReadTokens: 1234, durationMs: 42 };
      },
      async close() {
        closed++;
      },
    };
    return session;
  };
  return { open, opens, sends, closedCount: () => closed };
}

const noContext = () => '';

describe('nextRefineWork (pure)', () => {
  const ev = (type: string, detail: unknown, id = 0): TicketEvent => ({
    id,
    ticketId: 1,
    type,
    detail,
    createdAt: id,
  });

  it('returns null when there are no refine events', () => {
    expect(nextRefineWork([ev('created', null)])).toBeNull();
  });

  it('first turn: prompt is the human text, no resume id', () => {
    const work = nextRefineWork([ev('created', null, 1), ev(REFINE_EVENT_TYPE.human, { text: 'the body' }, 2)]);
    expect(work).toEqual({ prompt: 'the body', resumeSessionId: undefined });
  });

  it('returns null when the newest refine event is an agent turn (caught up)', () => {
    const work = nextRefineWork([
      ev(REFINE_EVENT_TYPE.human, { text: 'q' }, 1),
      ev(REFINE_EVENT_TYPE.agent, { text: 'a', sessionId: 's' }, 2),
    ]);
    expect(work).toBeNull();
  });

  it('resumes from the last agent turn and joins queued human replies', () => {
    const work = nextRefineWork([
      ev(REFINE_EVENT_TYPE.human, { text: 'body' }, 1),
      ev(REFINE_EVENT_TYPE.agent, { text: 'plan', sessionId: 'sess-42' }, 2),
      ev(REFINE_EVENT_TYPE.human, { text: 'reply one' }, 3),
      ev(REFINE_EVENT_TYPE.human, { text: 'reply two' }, 4),
    ]);
    expect(work).toEqual({ prompt: 'reply one\n\nreply two', resumeSessionId: 'sess-42' });
  });
});

describe('findPendingRefineTicketIds', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seq = 0;
  });

  it('finds tickets whose newest human turn is newer than the newest agent turn', () => {
    addTicket(db, 1, 'PD-1'); // pending (human only)
    addTicket(db, 2, 'PD-2'); // caught up (agent newest)
    addTicket(db, 3, 'PD-3'); // no refine events
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'a' });
    addEvent(db, 2, REFINE_EVENT_TYPE.human, { text: 'a' });
    addEvent(db, 2, REFINE_EVENT_TYPE.agent, { text: 'b', sessionId: 's' });
    addEvent(db, 3, 'created', null);
    expect(findPendingRefineTicketIds(db).sort()).toEqual([1]);
  });

  it('re-lists a caught-up ticket once a new human reply arrives', () => {
    addTicket(db, 2, 'PD-2');
    addEvent(db, 2, REFINE_EVENT_TYPE.human, { text: 'a' });
    addEvent(db, 2, REFINE_EVENT_TYPE.agent, { text: 'b', sessionId: 's' });
    expect(findPendingRefineTicketIds(db)).toEqual([]);
    addEvent(db, 2, REFINE_EVENT_TYPE.human, { text: 'follow-up' });
    expect(findPendingRefineTicketIds(db)).toEqual([2]);
  });
});

describe('processPendingRefines (orchestration)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seq = 0;
  });

  it('answers a pending ticket: writes a refine_agent turn + an agent_refine notification', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine this' });
    const fake = fakeSessions('here is my plan', 'sess-1');

    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(fake.open),
      buildContext: noContext,
      now: () => ++seq,
    });

    expect(handled).toBe(1);
    expect(fake.sends[0].prompt).toBe('refine this');
    const agentTurns = listTicketEvents(db, 1).filter((e) => e.type === REFINE_EVENT_TYPE.agent);
    expect(agentTurns).toHaveLength(1);
    expect((agentTurns[0].detail as { sessionId?: string }).sessionId).toBe('sess-1');
    const notif = db.prepare('SELECT * FROM agent_notifications').get() as { kind: string; title: string };
    expect(notif.kind).toBe('agent_refine');
    expect(notif.title).toContain('PD-1');
  });

  it('opens cold with the persisted session id (survives a worker restart)', async () => {
    // A thread that already had one agent turn BEFORE this process started — the post-restart
    // state, rehydrated purely from the DB.
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'body' });
    addEvent(db, 1, REFINE_EVENT_TYPE.agent, { text: 'plan', sessionId: 'sess-OLD' });
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'a follow-up' });
    const fake = fakeSessions('answer', 'sess-OLD');

    await processPendingRefines(db, CONFIG, { sessions: new WarmSessions(fake.open), buildContext: noContext, now: () => ++seq });

    expect(fake.opens[0].resumeSessionId).toBe('sess-OLD'); // cold open rehydrated
    expect(fake.sends[0].prompt).toBe('a follow-up');
  });

  it('reuses the WARM session across turns — one open, no per-turn resume', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q1' });
    const fake = fakeSessions('a1', 'sess-1');
    const sessions = new WarmSessions(fake.open);

    await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq });
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q2' });
    await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq });

    expect(fake.opens).toHaveLength(1); // opened once, reused for the 2nd turn
    expect(fake.sends.map((s) => s.prompt)).toEqual(['q1', 'q2']);
    expect(sessions.has(1)).toBe(true);
  });

  it('is idempotent — a second cycle with no new human turn does nothing', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q' });
    const sessions = new WarmSessions(fakeSessions('a').open);
    expect(await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq })).toBe(1);
    expect(await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq })).toBe(0);
  });

  it('leaves the ticket pending when the turn returns empty text (no bogus agent turn)', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q' });
    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(fakeSessions('   ').open),
      buildContext: noContext,
    });
    expect(handled).toBe(0);
    expect(listTicketEvents(db, 1).some((e) => e.type === REFINE_EVENT_TYPE.agent)).toBe(false);
    expect(findPendingRefineTicketIds(db)).toEqual([1]); // still pending → will retry
  });

  it('does NOT persist an API-error result as a turn (billing/auth) — leaves it pending', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    // ok:false with error text (what the SDK returns for "credit balance too low" etc.).
    const erroring: OpenRefineSession = () => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: Date.now(),
      async send(): Promise<RefineTurnResult> {
        return { text: 'Credit balance is too low', ok: false, sessionId: 'sess-1' };
      },
      async close() {},
    });
    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(erroring),
      buildContext: noContext,
    });
    expect(handled).toBe(0);
    // The error text must NOT appear as an agent turn, and the ticket stays pending.
    expect(listTicketEvents(db, 1).some((e) => e.type === REFINE_EVENT_TYPE.agent)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_notifications').get()).toEqual({ c: 0 });
    expect(findPendingRefineTicketIds(db)).toEqual([1]);
  });

  it('does not raise a second unread notification for a follow-up turn', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q1' });
    const sessions = new WarmSessions(fakeSessions('a1').open);
    await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq });
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'q2' });
    await processPendingRefines(db, CONFIG, { sessions, buildContext: noContext, now: () => ++seq });
    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_notifications').get() as { c: number };
    expect(count.c).toBe(1); // first is still unread → deduped
  });

  it('recovers from a stale resume session by retrying fresh (survives a rebuild)', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'the body' });
    addEvent(db, 1, REFINE_EVENT_TYPE.agent, { text: 'earlier plan', sessionId: 'sess-DEAD' });
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'a follow-up' });

    // A session that fails a resume (dead sessionId) but succeeds when opened fresh.
    const opens: OpenSessionInput[] = [];
    const open: OpenRefineSession = (input) => {
      opens.push(input);
      return {
        get sessionId() {
          return input.resumeSessionId ? 'sess-DEAD' : 'sess-NEW';
        },
        lastUsedAt: Date.now(),
        async send(prompt: string): Promise<RefineTurnResult> {
          if (input.resumeSessionId) {
            return {
              text: `No conversation found with session ID: ${input.resumeSessionId}`,
              ok: false,
              sessionId: input.resumeSessionId,
            };
          }
          // Fresh session gets the full-thread replay (must include earlier turns).
          expect(prompt).toContain('earlier plan');
          expect(prompt).toContain('a follow-up');
          return { text: 'fresh grounded plan', ok: true, sessionId: 'sess-NEW' };
        },
        async close() {},
      };
    };

    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(open),
      buildContext: noContext,
      now: () => ++seq,
    });

    expect(handled).toBe(1);
    // Opened twice: once resuming the dead id, then fresh (no resume).
    expect(opens.map((o) => o.resumeSessionId)).toEqual(['sess-DEAD', undefined]);
    const agentTurns = listTicketEvents(db, 1).filter((e) => e.type === REFINE_EVENT_TYPE.agent);
    expect((agentTurns.at(-1)?.detail as { text: string }).text).toBe('fresh grounded plan');
    expect((agentTurns.at(-1)?.detail as { sessionId: string }).sessionId).toBe('sess-NEW');
  });
});

describe('WarmSessions', () => {
  it('sweeps sessions idle past the timeout and closes them (cold rehydrate next time)', () => {
    const fake = fakeSessions('a');
    const sessions = new WarmSessions(fake.open, 1000);
    void sessions.turn(1, { config: CONFIG, contextPack: '' }, 'hi'); // opens synchronously
    expect(sessions.size()).toBe(1);
    expect(sessions.sweep(0)).toBe(0); // "now" before lastUsedAt → not idle
    expect(sessions.size()).toBe(1);
    expect(sessions.sweep(Date.now() + 10_000)).toBe(1); // well past the 1s idle window
    expect(sessions.size()).toBe(0);
    expect(fake.closedCount()).toBe(1);
  });
});

describe('propose_commit path (D-044, PD-269)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seq = 0;
  });

  it('writeRefineProposal persists a refine_proposal event + an agent_refine notification', () => {
    addTicket(db, 1, 'PD-1');
    const proposal: RefineProposal = { mode: 'decompose', rationale: 'too big', children: [] };
    writeRefineProposal(db, 1, proposal, ++seq);
    const events = listTicketEvents(db, 1).filter((e) => e.type === REFINE_PROPOSAL_EVENT.proposal);
    expect(events).toHaveLength(1);
    expect((events[0].detail as RefineProposal).mode).toBe('decompose');
    const notif = db.prepare('SELECT kind, title FROM agent_notifications').get() as {
      kind: string;
      title: string;
    };
    expect(notif.kind).toBe('agent_refine');
    expect(notif.title).toContain('split');
  });

  it('writeRefineProposal frames a decompose on an Epic as "members" (D-058 Populate)', () => {
    addTicket(db, 1, 'PD-1', /* isEpic */ true);
    writeRefineProposal(db, 1, { mode: 'decompose', rationale: 'flesh out', children: [] }, ++seq);
    const notif = db.prepare('SELECT title FROM agent_notifications').get() as { title: string };
    expect(notif.title).toContain('members');
    expect(notif.title).not.toContain('split');
  });

  it('processPendingRefines wires onProposal so a tool call records a proposal', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    // Fake session that "calls propose_commit" mid-turn via the injected onProposal.
    const proposal: RefineProposal = { mode: 'refine_in_place', body: 'tightened' };
    const open: OpenRefineSession = (input: OpenSessionInput) => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: Date.now(),
      async send(): Promise<RefineTurnResult> {
        input.onProposal?.(proposal); // agent invoked the tool
        return { text: 'here is my proposal', ok: true, sessionId: 'sess-1' };
      },
      async close() {},
    });

    await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(open),
      buildContext: noContext,
      now: () => ++seq,
    });

    const proposals = listTicketEvents(db, 1).filter((e) => e.type === REFINE_PROPOSAL_EVENT.proposal);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].detail as RefineProposal).body).toBe('tightened');
  });
});


/**
 * PD-618. On 2026-09-01 a single refine turn that could not succeed was retried every 5 seconds
 * from 01:55 until the worker was stopped the next morning — roughly 6,000 attempts. Nothing
 * capped the rate, nothing recognised a provider limit, and nothing capped a single turn.
 */
describe('failed turns are spaced, not hammered (PD-618)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  const run = (clock: () => number, backoff: RefineBackoff, open: OpenRefineSession) =>
    processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(open),
      backoff,
      buildContext: noContext,
      now: clock,
    });

  it('skips a ticket that failed moments ago, and retries it once the wait passes', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    let attempts = 0;
    const counting: OpenRefineSession = () => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: 0,
      async send(): Promise<RefineTurnResult> {
        attempts += 1;
        return { text: 'boom', ok: false, sessionId: 'sess-1' };
      },
      async close() {},
    });
    const backoff = new RefineBackoff(30_000, 30 * 60_000);
    let t = 1_000_000;

    await run(() => t, backoff, counting);
    expect(attempts).toBe(1);

    // The 5-second poll that used to re-fire immediately.
    t += 5_000;
    await run(() => t, backoff, counting);
    expect(attempts).toBe(1);

    t += 30_000; // past the first backoff
    await run(() => t, backoff, counting);
    expect(attempts).toBe(2);
  });

  it('backs off exponentially, capped', () => {
    const backoff = new RefineBackoff(30_000, 120_000);
    const waits = [1, 2, 3, 4, 5, 6].map(() => backoff.recordFailure(1, 0).waitMs);
    expect(waits).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  });

  // The point of leaving a turn pending is that the human never has to re-send a reply. Bounding
  // the RATE fixes the incident; bounding the COUNT would break the recovery.
  it('never gives up entirely', () => {
    const backoff = new RefineBackoff(30_000, 60_000);
    for (let i = 0; i < 500; i += 1) backoff.recordFailure(1, 0);
    expect(backoff.ready(1, 10 * 60_000)).toBe(true);
  });

  it('forgets the history after a clean turn, so recovery is immediate', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    const backoff = new RefineBackoff(30_000, 30 * 60_000);
    backoff.recordFailure(1, 1_000_000);
    let t = 1_000_000 + 60_000; // past the first backoff window
    await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(fakeSessions('a good reply').open),
      backoff,
      buildContext: noContext,
      now: () => t++,
    });
    // Cleared, so the NEXT failure starts from the base wait again rather than compounding.
    expect(backoff.ready(1, 0)).toBe(true);
  });
});

describe('a provider session limit stops every refine turn (PD-618)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  function limited(): OpenRefineSession {
    return () => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: 0,
      async send(): Promise<RefineTurnResult> {
        // The literal string the worker logged on 2026-09-01, kept verbatim: this test exists
        // because that text was retried every 5s for eight hours instead of being recognised.
        return { text: "You've hit your session limit · resets 9am (UTC)", ok: false, sessionId: 'sess-1' };
      },
      async close() {},
    });
  }

  it('takes the hold rather than retrying into the limit', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(limited()),
      buildContext: noContext,
      now: () => 1_000_000,
    });
    const hold = sessionLimitHold(db);
    expect(hold).not.toBeNull();
    expect(hold!.until).toBeGreaterThan(1_000_000);
  });

  // The quota is one quota, so the hold the Robot already maintains (PD-470) is the one Refine
  // reads. A limit parking the Robot used to leave Refine retrying into it.
  it('does no work at all while a hold set by the Robot is in force', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    holdForSessionLimit(db, 2_000_000, 'robot hit the limit', 1_000_000);
    let attempts = 0;
    const counting: OpenRefineSession = () => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: 0,
      async send(): Promise<RefineTurnResult> {
        attempts += 1;
        return { text: 'ok', ok: true, sessionId: 'sess-1' };
      },
      async close() {},
    });
    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(counting),
      buildContext: noContext,
      now: () => 1_500_000,
    });
    expect(handled).toBe(0);
    expect(attempts).toBe(0);
    expect(findPendingRefineTicketIds(db)).toEqual([1]); // still pending, nothing lost
  });

  it('resumes on its own once the hold expires', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'refine me' });
    holdForSessionLimit(db, 2_000_000, 'earlier limit', 1_000_000);
    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(fakeSessions('back in business').open),
      buildContext: noContext,
      now: () => 2_500_000, // past `until`
    });
    expect(handled).toBe(1);
    expect(sessionLimitHold(db)).toBeNull(); // self-cleared on read
  });
});
