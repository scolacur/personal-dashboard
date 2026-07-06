import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { RefineProposal, TicketEvent } from '@dashboard/shared';
import { REFINE_EVENT_TYPE, REFINE_PROPOSAL_EVENT } from '@dashboard/shared';
import type { GrillerConfig } from './config';
import type { GrillSession, GrillTurnResult, OpenGrillSession, OpenSessionInput } from './session';
import {
  nextRefineWork,
  findPendingRefineTicketIds,
  listTicketEvents,
  processPendingRefines,
  writeRefineProposal,
  WarmSessions,
} from './refine';

// Minimal slice of the shared dashboard schema the griller touches (the web app owns the
// canonical schema; the griller only reads/writes these three tables).
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_tickets (
      id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL
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
  return db;
}

let seq = 0;
function addTicket(db: Database.Database, id: number, displayId: string): void {
  db.prepare('INSERT INTO agent_tickets (id, display_id, title) VALUES (?, ?, ?)').run(id, displayId, 't');
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

const CONFIG: GrillerConfig = {
  model: 'claude-opus-4-8',
  githubRepo: 'x/y',
  githubReadToken: '',
  checkoutDir: '/co',
  dataDir: '/data',
  pullIntervalMs: 1,
  refineIntervalMs: 1,
  httpsProxy: '',
};

/** A fake session factory: records every open() + send(), returns canned replies. Each open
 *  models a fresh subprocess; a warm reuse sends into an existing fake session (no new open). */
function fakeSessions(reply: string, sessionId = 'sess-1') {
  const opens: OpenSessionInput[] = [];
  const sends: { prompt: string; resumeSessionId?: string }[] = [];
  let closed = 0;
  const open: OpenGrillSession = (input) => {
    opens.push(input);
    let sid = input.resumeSessionId ?? sessionId;
    const session: GrillSession = {
      get sessionId() {
        return sid;
      },
      lastUsedAt: Date.now(),
      async send(prompt: string): Promise<GrillTurnResult> {
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
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'grill this' });
    const fake = fakeSessions('here is my plan', 'sess-1');

    const handled = await processPendingRefines(db, CONFIG, {
      sessions: new WarmSessions(fake.open),
      buildContext: noContext,
      now: () => ++seq,
    });

    expect(handled).toBe(1);
    expect(fake.sends[0].prompt).toBe('grill this');
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
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'grill me' });
    // ok:false with error text (what the SDK returns for "credit balance too low" etc.).
    const erroring: OpenGrillSession = () => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: Date.now(),
      async send(): Promise<GrillTurnResult> {
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

  it('processPendingRefines wires onProposal so a tool call records a proposal', async () => {
    addTicket(db, 1, 'PD-1');
    addEvent(db, 1, REFINE_EVENT_TYPE.human, { text: 'grill me' });
    // Fake session that "calls propose_commit" mid-turn via the injected onProposal.
    const proposal: RefineProposal = { mode: 'refine_in_place', body: 'tightened' };
    const open: OpenGrillSession = (input: OpenSessionInput) => ({
      get sessionId() {
        return 'sess-1';
      },
      lastUsedAt: Date.now(),
      async send(): Promise<GrillTurnResult> {
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
