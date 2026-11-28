import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {
  approveSuggestionError,
  fileSuggestionError,
  findingLine,
  resolvedApproval,
  type FileSuggestionInput,
  type SuggestionFinding,
} from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createTicket, getProjectBySlug, getTicket, listTicketEvents, listNotifications } from './store';
import {
  approveTicketSuggestion,
  fileTicketSuggestion,
  getTicketSuggestion,
  listTicketSuggestions,
  rejectTicketSuggestion,
} from './ticket-suggestions';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function pid(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no project');
  return p.id;
}

/** An Epic plus a robot member ticket under it, as the Evaluator's source ticket would be. */
function sourceSetup(db: Database.Database) {
  const projectId = pid(db);
  const epic = createTicket(db, { title: 'Auto-merge Epic', projectId, isEpic: true });
  const source = createTicket(db, {
    title: 'Ship the thing',
    projectId,
    epicId: epic.id,
    assignee: 'robot',
  });
  return { projectId, epic, source };
}

const FINDINGS: SuggestionFinding[] = [
  { kind: 'convention', where: 'apps/server/src/x.ts:12', what: 'prefer const over let' },
  { kind: 'readability', where: 'apps/web/src/y.ts:3', what: 'name the magic number' },
];

function fileInput(db: Database.Database, over: Partial<FileSuggestionInput> = {}): FileSuggestionInput {
  const { source } = sourceSetup(db);
  return {
    sourceTicketId: source.id,
    prNumber: 42,
    repo: 'scolacur/personal-dashboard',
    proposedTitle: 'Clean up leftovers from PR #42',
    proposedBody: 'Address the non-blocking findings.',
    findings: FINDINGS,
    ...over,
  };
}

describe('ticket-suggestions store', () => {
  it('files a pending suggestion that defaults its epic to the source ticket and appears in the list', () => {
    const db = freshDb();
    const { source, epic } = sourceSetup(db);
    const s = fileTicketSuggestion(db, {
      sourceTicketId: source.id,
      prNumber: 7,
      repo: 'scolacur/personal-dashboard',
      proposedTitle: 'Follow-ups',
      proposedBody: 'body',
      findings: FINDINGS,
    });
    expect(s.status).toBe('pending');
    expect(s.proposedEpicId).toBe(epic.id);
    expect(s.sourceTicketDisplayId).toBe(source.displayId);
    expect(s.sourceTicketTitle).toBe(source.title);
    expect(s.findings).toHaveLength(2);

    const list = listTicketSuggestions(db);
    expect(list.count).toBe(1);
    expect(list.items.map((i) => i.id)).toEqual([s.id]);
  });

  it('records a suggestion_filed timeline event and posts one notification', () => {
    const db = freshDb();
    const { source } = sourceSetup(db);
    fileTicketSuggestion(db, {
      sourceTicketId: source.id,
      prNumber: 7,
      proposedTitle: 'Follow-ups',
      proposedBody: 'body',
      findings: FINDINGS,
    });
    const events = listTicketEvents(db, source.id).filter((e) => e.type === 'suggestion_filed');
    expect(events).toHaveLength(1);
    const notes = listNotifications(db).filter((n) => n.kind === 'agent_ticket_suggestion');
    expect(notes).toHaveLength(1);
    expect(notes[0].ticketId).toBe(source.id);
  });

  it('filing again for the same PR updates the pending suggestion, not a second one', () => {
    const db = freshDb();
    const { source } = sourceSetup(db);
    const base = {
      sourceTicketId: source.id,
      prNumber: 99,
      repo: 'scolacur/personal-dashboard',
      proposedBody: 'b',
      findings: FINDINGS,
    };
    const first = fileTicketSuggestion(db, { ...base, proposedTitle: 'First' });
    const second = fileTicketSuggestion(db, {
      ...base,
      proposedTitle: 'Second',
      findings: [FINDINGS[0]],
    });
    expect(second.id).toBe(first.id);
    const list = listTicketSuggestions(db);
    expect(list.count).toBe(1);
    expect(list.items[0].proposedTitle).toBe('Second');
    expect(list.items[0].findings).toHaveLength(1);
  });

  it('treats a different repo with the same PR number as a distinct suggestion', () => {
    const db = freshDb();
    const { source } = sourceSetup(db);
    const base = { sourceTicketId: source.id, prNumber: 5, proposedTitle: 't', proposedBody: 'b', findings: FINDINGS };
    fileTicketSuggestion(db, { ...base, repo: 'a/one' });
    fileTicketSuggestion(db, { ...base, repo: 'b/two' });
    expect(listTicketSuggestions(db).count).toBe(2);
  });

  it('approve creates a backlog, unrefined ticket in the chosen epic and links it back', () => {
    const db = freshDb();
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = approveTicketSuggestion(db, s.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.suggestion.status).toBe('approved');
    expect(res.suggestion.createdTicketId).not.toBeNull();
    const created = getTicket(db, res.suggestion.createdTicketId!);
    expect(created?.status).toBe('backlog');
    expect(created?.refined).toBe(false);
    expect(created?.epicId).toBe(s.proposedEpicId);
    expect(created?.title).toBe(s.proposedTitle);
    expect(listTicketEvents(db, s.sourceTicketId).some((e) => e.type === 'suggestion_approved')).toBe(true);
  });

  it('approve honours title / body / epic edits (Modify)', () => {
    const db = freshDb();
    const projectId = pid(db);
    const otherEpic = createTicket(db, { title: 'Other Epic', projectId, isEpic: true });
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = approveTicketSuggestion(db, s.id, {
      title: 'Edited title',
      body: 'edited body',
      epicId: otherEpic.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const created = getTicket(db, res.suggestion.createdTicketId!);
    expect(created?.title).toBe('Edited title');
    expect(created?.body).toBe('edited body');
    expect(created?.epicId).toBe(otherEpic.id);
  });

  it('refuses approve when there is no epic (D-080)', () => {
    const db = freshDb();
    const projectId = pid(db);
    // A source ticket with no epic → the suggestion inherits a null epic.
    const orphan = createTicket(db, { title: 'orphan', projectId, isEpic: true }); // epic has epic_id null
    const s = fileTicketSuggestion(db, {
      sourceTicketId: orphan.id,
      prNumber: 3,
      proposedTitle: 't',
      proposedBody: 'b',
      findings: FINDINGS,
    });
    expect(s.proposedEpicId).toBeNull();
    const res = approveTicketSuggestion(db, s.id);
    expect(res).toEqual({ ok: false, reason: 'epic_required' });
  });

  it('reject records the decision and its reason', () => {
    const db = freshDb();
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = rejectTicketSuggestion(db, s.id, 'not worth it');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.suggestion.status).toBe('rejected');
    expect(res.suggestion.rejectReason).toBe('not worth it');
    expect(listTicketEvents(db, s.sourceTicketId).some((e) => e.type === 'suggestion_rejected')).toBe(true);
  });

  it('is idempotent and refuses deciding a decided suggestion again', () => {
    const db = freshDb();
    const s = fileTicketSuggestion(db, fileInput(db));
    const first = approveTicketSuggestion(db, s.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const createdId = first.suggestion.createdTicketId;

    // Approving again is a no-op success — no second ticket.
    const again = approveTicketSuggestion(db, s.id);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.suggestion.createdTicketId).toBe(createdId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_tickets').get() as { n: number }).n).toBe(
      // epic + source + the one created ticket
      3,
    );

    // Rejecting an approved one is refused.
    expect(rejectTicketSuggestion(db, s.id)).toEqual({ ok: false, reason: 'already_decided' });
  });

  it('rejecting twice is idempotent, and approving a rejected one is refused', () => {
    const db = freshDb();
    const s = fileTicketSuggestion(db, fileInput(db));
    expect(rejectTicketSuggestion(db, s.id, 'no').ok).toBe(true);
    expect(rejectTicketSuggestion(db, s.id).ok).toBe(true); // idempotent
    expect(approveTicketSuggestion(db, s.id)).toEqual({ ok: false, reason: 'already_decided' });
  });

  it('returns not_found for a missing suggestion', () => {
    const db = freshDb();
    expect(approveTicketSuggestion(db, 999)).toEqual({ ok: false, reason: 'not_found' });
    expect(rejectTicketSuggestion(db, 999)).toEqual({ ok: false, reason: 'not_found' });
    expect(getTicketSuggestion(db, 999)).toBeNull();
  });
});

describe('shared ticket-suggestion validators', () => {
  it('fileSuggestionError accepts a well-formed input and flags problems', () => {
    const good: FileSuggestionInput = {
      sourceTicketId: 1,
      prNumber: 2,
      proposedTitle: 't',
      proposedBody: '',
      findings: FINDINGS,
    };
    expect(fileSuggestionError(good)).toBeNull();
    expect(fileSuggestionError({ ...good, proposedTitle: '  ' })?.code).toBe('INVALID_TITLE');
    expect(fileSuggestionError({ ...good, prNumber: 0 })?.code).toBe('INVALID_PR_NUMBER');
    expect(fileSuggestionError({ ...good, findings: [] })?.code).toBe('NO_FINDINGS');
    expect(
      fileSuggestionError({ ...good, findings: [{ kind: 'x' } as unknown as SuggestionFinding] })?.code,
    ).toBe('INVALID_FINDING');
  });

  it('approveSuggestionError flags a blank title but allows an empty body', () => {
    expect(approveSuggestionError({})).toBeNull();
    expect(approveSuggestionError({ title: '  ' })?.code).toBe('INVALID_TITLE');
    expect(approveSuggestionError({ body: '' })).toBeNull();
    expect(approveSuggestionError({ epicId: 1.5 })?.code).toBe('INVALID_EPIC_ID');
    expect(approveSuggestionError({ epicId: null })).toBeNull();
  });

  it('resolvedApproval applies edits over the proposal', () => {
    const base = { proposedTitle: 'orig', proposedBody: 'ob', proposedEpicId: 4 };
    expect(resolvedApproval(base)).toEqual({ title: 'orig', body: 'ob', epicId: 4 });
    expect(resolvedApproval(base, { title: ' new ', epicId: 9 })).toEqual({
      title: 'new',
      body: 'ob',
      epicId: 9,
    });
  });

  it('findingLine renders with and without a location', () => {
    expect(findingLine({ kind: 'convention', where: 'a.ts:1', what: 'do x' })).toBe(
      'convention — a.ts:1: do x',
    );
    expect(findingLine({ kind: 'convention', where: '', what: 'do x' })).toBe('convention: do x');
  });
});

describe('ticket-suggestion routes', () => {
  function app(db: Database.Database) {
    const a = Fastify({ logger: false });
    registerRoutes(a, db);
    return a;
  }
  const BASE = '/api/widgets/task-monitor/ticket-suggestions';

  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('lists pending and decided suggestions', async () => {
    const a = app(db);
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = await a.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe(s.id);
  });

  it('approves through the API and creates the ticket', async () => {
    const a = app(db);
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = await a.inject({ method: 'POST', url: `${BASE}/${s.id}/approve`, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().createdTicketId).not.toBeNull();
  });

  it('rejects a blank title edit with 400', async () => {
    const a = app(db);
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = await a.inject({ method: 'POST', url: `${BASE}/${s.id}/approve`, payload: { title: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TITLE');
  });

  it('404s an unknown suggestion and 409s a re-decide', async () => {
    const a = app(db);
    const miss = await a.inject({ method: 'POST', url: `${BASE}/123/reject`, payload: {} });
    expect(miss.statusCode).toBe(404);
    const s = fileTicketSuggestion(db, fileInput(db));
    await a.inject({ method: 'POST', url: `${BASE}/${s.id}/approve`, payload: {} });
    const again = await a.inject({ method: 'POST', url: `${BASE}/${s.id}/reject`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_DECIDED');
  });

  it('rejects via the API with a reason', async () => {
    const a = app(db);
    const s = fileTicketSuggestion(db, fileInput(db));
    const res = await a.inject({ method: 'POST', url: `${BASE}/${s.id}/reject`, payload: { reason: 'dup' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
    expect(res.json().rejectReason).toBe('dup');
  });
});
