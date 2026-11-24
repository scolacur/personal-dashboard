import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BODY_CHARS_MAX,
  SEARCH_LIMIT_MAX,
  getTicket,
  listEpicMembers,
  listRelations,
  read,
  searchTickets,
} from './board-tools';

let db: Database.Database;

function add(id: number, displayId: string, title: string, over: Partial<{ body: string; status: string; epic: number; isEpic: boolean; archived: boolean; refined: boolean; closeReason: string }> = {}) {
  db.prepare(
    `INSERT INTO agent_tickets (id, display_id, title, body, status, priority, assignee, is_epic, refined, close_reason, epic_id, archived_at, sort_order)
     VALUES (?, ?, ?, ?, ?, 'P1', 'robot', ?, ?, ?, ?, ?, ?)`,
  ).run(id, displayId, title, over.body ?? '', over.status ?? 'backlog', over.isEpic ? 1 : 0, over.refined ? 1 : 0, over.closeReason ?? null, over.epic ?? null, over.archived ? 1 : null, id);
}

function addRel(fromId: number, toId: number, type: string) {
  db.prepare("INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (?, ?, ?, 0)").run(
    fromId,
    toId,
    type,
  );
}

let eventSeq = 0;
function addEvent(ticketId: number, type: string, detail?: unknown) {
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
    ++eventSeq,
  );
}

beforeEach(() => {
  eventSeq = 0;
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'none', assignee TEXT, is_epic INTEGER NOT NULL DEFAULT 0, refined INTEGER NOT NULL DEFAULT 0,
      close_reason TEXT, epic_id INTEGER, archived_at INTEGER, sort_order REAL NOT NULL DEFAULT 0);
    CREATE TABLE agent_ticket_relations (id INTEGER PRIMARY KEY, from_ticket_id INTEGER NOT NULL, to_ticket_id INTEGER NOT NULL,
      type TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'agent', created_at INTEGER NOT NULL);
    CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL,
      detail TEXT, created_at INTEGER NOT NULL);
  `);
  add(1, 'PD-609', '[Epic] Robot loop hardening', { isEpic: true, refined: true });
  add(2, 'PD-350', 'Karpathy memory wiki', { body: 'Persist a wiki of what the agents learn.', epic: 1 });
  add(3, 'PD-433', '[Refine] Give the Refine agent read-only board access', { body: 'MCP tools, no Bash.', epic: 1 });
  add(4, 'PD-263', 'Karpathy Sortie wiki tracer', { status: 'closed' });
  add(5, 'PD-999', 'Archived memory thing', { archived: true });
  db.prepare("INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (3, 2, 'blocks', 0)").run();
});

describe('searchTickets (PD-433)', () => {
  it('matches every word in title or body, compact, open only by default, never archived', () => {
    const r = searchTickets(db, { query: 'karpathy' });
    expect(r.results.map((t) => t.displayId)).toEqual(['PD-350']);
    expect(r.results[0]).toEqual({
      displayId: 'PD-350', title: 'Karpathy memory wiki', status: 'backlog', priority: 'P1', assignee: 'robot', isEpic: false, refined: false, epic: 'PD-609', closeReason: null, closedInto: [],
    });
    expect(r.results[0]).not.toHaveProperty('body');
    expect(searchTickets(db, { query: 'karpathy', includeDone: true }).results.map((t) => t.displayId)).toEqual(['PD-263', 'PD-350']);
    expect(searchTickets(db, { query: 'memory' }).results.map((t) => t.displayId)).toEqual(['PD-350']);
  });

  it('finds by body text and by exact display id, and filters by Epic', () => {
    expect(searchTickets(db, { query: 'bash' }).results.map((t) => t.displayId)).toEqual(['PD-433']);
    expect(searchTickets(db, { query: 'pd-433' }).results.map((t) => t.displayId)).toEqual(['PD-433']);
    expect(searchTickets(db, { query: 'refine', epic: 'pd-609' }).results).toHaveLength(1);
  });

  it('treats LIKE wildcards literally', () => {
    expect(searchTickets(db, { query: '%' }).results).toEqual([]);
  });

  it('hard-caps results and says when it truncated', () => {
    for (let i = 100; i < 140; i++) add(i, `PD-${i}`, `Widget ${i}`);
    const r = searchTickets(db, { query: 'widget', limit: 1000 });
    expect(r.results).toHaveLength(SEARCH_LIMIT_MAX);
    expect(r.truncated).toBe(true);
    expect(searchTickets(db, { query: 'widget' }).results).toHaveLength(10);
  });
});

describe('getTicket / listRelations / listEpicMembers (PD-433)', () => {
  it('reads one ticket with its Epic, a truncated body and its relation count', () => {
    db.prepare('UPDATE agent_tickets SET body = ? WHERE id = 2').run('x'.repeat(BODY_CHARS_MAX + 10));
    const t = getTicket(db, 'pd-350');
    expect(t?.epicTitle).toBe('[Epic] Robot loop hardening');
    expect(t?.body).toHaveLength(BODY_CHARS_MAX);
    expect(t?.bodyTruncated).toBe(true);
    expect(t?.relations).toBe(1);
    expect(getTicket(db, 'PD-999')).toBeNull();
  });

  it('lists relations in both directions', () => {
    expect(listRelations(db, 'PD-350')).toEqual([expect.objectContaining({ type: 'blocks', direction: 'incoming', other: expect.objectContaining({ displayId: 'PD-433' }) })]);
    expect(listRelations(db, 'PD-433')?.[0].direction).toBe('outgoing');
    expect(listRelations(db, 'PD-1')).toBeNull();
  });

  it("lists an Epic's members and refuses a non-Epic", () => {
    expect(listEpicMembers(db, 'PD-609')?.members.map((m) => m.displayId)).toEqual(['PD-350', 'PD-433']);
    expect(listEpicMembers(db, 'PD-350')).toBeNull();
  });

  it('marks which members have an actionable proposal pending (PD-930)', () => {
    // PD-350: a proposal still awaiting a decision → actionable.
    addEvent(2, 'refine_proposal', { mode: 'refine_in_place', body: 'rewritten' });
    // PD-433: a proposal that was already committed → not actionable.
    addEvent(3, 'refine_proposal', { mode: 'refine_in_place', body: 'x' });
    addEvent(3, 'refine_committed');
    const members = listEpicMembers(db, 'PD-609')?.members ?? [];
    expect(members.map((m) => [m.displayId, m.hasActionableProposal])).toEqual([
      ['PD-350', true],
      ['PD-433', false],
    ]);
  });
});

describe('closeReason + closedInto on summaries (PD-888)', () => {
  it('shows a split parent its children, a duplicate its target, and leaves an open ticket empty', () => {
    // A split parent (PD-455-shaped): closed with close_reason='split', children via `split` relations.
    add(20, 'PD-455', 'Split the board: Epics and Tickets on separate pages', { status: 'closed', closeReason: 'split', refined: true });
    add(21, 'PD-874', 'Epics / Tickets / Both tabs', {});
    add(22, 'PD-875', 'Epic stripe + chip on ticket cards', {});
    addRel(20, 21, 'split');
    addRel(20, 22, 'split');
    // A duplicate: closed with an outgoing `duplicates` relation.
    add(23, 'PD-500', 'dup of PD-874', { status: 'closed', closeReason: 'duplicate' });
    addRel(23, 21, 'duplicates');

    const parent = getTicket(db, 'PD-455')!;
    expect(parent.closeReason).toBe('split');
    expect(parent.refined).toBe(true);
    expect(parent.closedInto).toEqual([
      { displayId: 'PD-874', title: 'Epics / Tickets / Both tabs' },
      { displayId: 'PD-875', title: 'Epic stripe + chip on ticket cards' },
    ]);

    const dup = getTicket(db, 'PD-500')!;
    expect(dup.closeReason).toBe('duplicate');
    expect(dup.closedInto).toEqual([{ displayId: 'PD-874', title: 'Epics / Tickets / Both tabs' }]);

    // An open ticket carries null + [].
    const open = getTicket(db, 'PD-350')!;
    expect(open.closeReason).toBeNull();
    expect(open.closedInto).toEqual([]);
  });

  it('shows a superseded member its successor, resolved from the refine_superseded event', () => {
    add(30, 'PD-700', 'old member', { status: 'closed', closeReason: 'superseded', refined: true });
    add(31, 'PD-701', 'the Epic that superseded it', { isEpic: true });
    addEvent(30, 'refine_superseded', { by: 'PD-701' });

    const member = getTicket(db, 'PD-700')!;
    expect(member.closeReason).toBe('superseded');
    expect(member.closedInto).toEqual([{ displayId: 'PD-701', title: 'the Epic that superseded it' }]);
  });

  it('list_relations and list_epic_members also carry closeReason + closedInto', () => {
    add(40, 'PD-800', 'split parent in an epic', { status: 'closed', closeReason: 'split', refined: true, epic: 1 });
    add(41, 'PD-801', 'the child', { epic: 1 });
    addRel(40, 41, 'split');

    const members = listEpicMembers(db, 'PD-609')?.members ?? [];
    const parentSummary = members.find((m) => m.displayId === 'PD-800')!;
    expect(parentSummary.closeReason).toBe('split');
    expect(parentSummary.closedInto).toEqual([{ displayId: 'PD-801', title: 'the child' }]);

    const edges = listRelations(db, 'PD-801') ?? [];
    const back = edges.find((e) => e.other.displayId === 'PD-800')!;
    expect(back.other.closeReason).toBe('split');
    expect(back.other.closedInto).toEqual([{ displayId: 'PD-801', title: 'the child' }]);
  });
});

describe('read-only guard (PD-433)', () => {
  it('refuses any statement that is not a reader', () => {
    expect(() => read(db, 'DELETE FROM agent_tickets')).toThrow(/read-only/);
    expect(() => read(db, "UPDATE agent_tickets SET title = 'x'")).toThrow(/read-only/);
  });
});
