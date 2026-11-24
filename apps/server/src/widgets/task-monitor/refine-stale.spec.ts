import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import {
  approveRefine,
  appendStructuredRefineReply,
  createTicket,
  getProjectBySlug,
  listTicketEvents,
  updateTicket,
} from './store';
import type { RefineProposal, RefineQuestionRound, TicketEvent } from '@dashboard/shared';
import {
  REFINE_EVENT_TYPE,
  REFINE_PROPOSAL_EVENT,
  REFINE_ROUND_STALE_EVENT,
  latestActionableProposal,
  refineStateFromLatestType,
  proposalCitedIds,
  roundCitedIds,
} from '@dashboard/shared';

const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}
function pd(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no pd project');
  return p.id;
}

/** Seed an open agent question round on `ticketId`, with the given `dependsOn`. */
function seedRound(db: Database.Database, ticketId: number, dependsOn: number[], round?: RefineQuestionRound): void {
  const r: RefineQuestionRound = round ?? {
    questions: [
      {
        id: 'q1',
        question: 'Which approach?',
        why: 'it decides the shape',
        options: [
          { label: 'A', description: 'do a' },
          { label: 'B', description: 'do b' },
        ],
        recommended: 0,
      },
    ],
    assumptions: [],
  };
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    REFINE_EVENT_TYPE.agent,
    JSON.stringify({ text: 'a question', sessionId: 's1', round: r, dependsOn }),
    Date.now(),
  );
}

/** Seed an actionable proposal on `ticketId` with the given `dependsOn`. */
function seedProposal(db: Database.Database, ticketId: number, dependsOn: number[], proposal?: RefineProposal): void {
  const p: RefineProposal = proposal ?? { mode: 'refine_in_place', body: ROBOT_BODY, rationale: 'r' };
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    REFINE_PROPOSAL_EVENT.proposal,
    JSON.stringify({ ...p, dependsOn }),
    Date.now(),
  );
}

function staleTurns(db: Database.Database, ticketId: number): TicketEvent[] {
  return listTicketEvents(db, ticketId).filter((e) => e.type === REFINE_ROUND_STALE_EVENT);
}

describe('roundCitedIds / proposalCitedIds (shared, PD-889)', () => {
  it('roundCitedIds collects ids from questions, why, options, and assumption sources', () => {
    const round: RefineQuestionRound = {
      questions: [
        {
          id: 'q1',
          question: 'Follow PD-455?',
          why: 'blocks PD-460 otherwise',
          options: [
            { label: 'Use PD-100', description: 'as in PD-101' },
            { label: 'other', description: 'nothing cited' },
          ],
          recommended: 0,
        },
      ],
      assumptions: [{ text: 'rely on the split', source: 'D-091 (queue gate), PD-742 (Async Refine)' }],
    };
    expect(roundCitedIds(round).sort()).toEqual(['D-091', 'PD-100', 'PD-101', 'PD-455', 'PD-460', 'PD-742']);
  });

  it('proposalCitedIds collects ids from body, rationale, children and supersedes', () => {
    const proposal: RefineProposal = {
      mode: 'decompose',
      rationale: 'replaces PD-876',
      children: [{ title: 'builds on PD-12', body: 'see PD-13', status: 'backlog', assignee: 'robot' }],
      supersedes: ['PD-876'],
    };
    expect(proposalCitedIds(proposal).sort()).toEqual(['PD-12', 'PD-13', 'PD-876']);
  });
});

describe('refineStateFromLatestType (PD-889)', () => {
  it('a stale turn reads as `refining`', () => {
    expect(refineStateFromLatestType(REFINE_ROUND_STALE_EVENT)).toBe('refining');
  });
});

describe('staleRefineDependents — triggers', () => {
  let db: Database.Database;
  let project: number;
  let cited: number; // the ticket other sessions depend on
  let session: number; // the ticket with the open round / proposal
  beforeEach(() => {
    db = freshDb();
    project = pd(db);
    cited = createTicket(db, { title: 'cited', projectId: project, body: 'orig' }).id;
    session = createTicket(db, { title: 'session', projectId: project }).id;
  });

  it('completing a cited ticket appends exactly one stale turn to the dependent session', () => {
    seedRound(db, session, [cited]);
    updateTicket(db, cited, { status: 'completed' });
    const stale = staleTurns(db, session);
    expect(stale).toHaveLength(1);
    const detail = stale[0].detail as { change: string; changedTicketId: number; invalidates: string };
    expect(detail.change).toBe('completed');
    expect(detail.changedTicketId).toBe(cited);
    expect(detail.invalidates).toBe('round');
  });

  it('closing a cited ticket appends a stale turn', () => {
    seedRound(db, session, [cited]);
    updateTicket(db, cited, { status: 'closed' });
    expect(staleTurns(db, session)).toHaveLength(1);
    expect((staleTurns(db, session)[0].detail as { change: string }).change).toBe('closed');
  });

  it('rewriting a cited ticket body appends a stale turn', () => {
    seedRound(db, session, [cited]);
    updateTicket(db, cited, { body: 'a completely rewritten body' });
    expect(staleTurns(db, session)).toHaveLength(1);
    expect((staleTurns(db, session)[0].detail as { change: string }).change).toBe('body');
  });

  it('moving a cited ticket to another Epic appends a stale turn', () => {
    const epic = createTicket(db, { title: 'E', projectId: project, isEpic: true }).id;
    seedRound(db, session, [cited]);
    updateTicket(db, cited, { epicId: epic });
    expect(staleTurns(db, session)).toHaveLength(1);
    expect((staleTurns(db, session)[0].detail as { change: string }).change).toBe('epic_move');
  });

  it('a pending proposal that cites the changed ticket is staled and stops being actionable', () => {
    seedProposal(db, session, [cited]);
    expect(latestActionableProposal(listTicketEvents(db, session))).not.toBeNull();
    updateTicket(db, cited, { status: 'closed' });
    expect(staleTurns(db, session)).toHaveLength(1);
    expect((staleTurns(db, session)[0].detail as { invalidates: string }).invalidates).toBe('proposal');
    // Terminated — approval now refuses.
    expect(latestActionableProposal(listTicketEvents(db, session))).toBeNull();
  });

  it('both an open round AND a pending proposal are covered by one stale turn (invalidates=both)', () => {
    seedProposal(db, session, [cited]);
    seedRound(db, session, [cited]); // newest state event is the round
    updateTicket(db, cited, { body: 'changed' });
    const stale = staleTurns(db, session);
    expect(stale).toHaveLength(1);
    expect((stale[0].detail as { invalidates: string }).invalidates).toBe('both');
  });
});

describe('staleRefineDependents — non-triggers & scoping', () => {
  let db: Database.Database;
  let project: number;
  let cited: number;
  let session: number;
  beforeEach(() => {
    db = freshDb();
    project = pd(db);
    cited = createTicket(db, { title: 'cited', projectId: project }).id;
    session = createTicket(db, { title: 'session', projectId: project }).id;
    seedRound(db, session, [cited]);
  });

  it('a priority change does not stale', () => {
    updateTicket(db, cited, { priority: 'P1' });
    expect(staleTurns(db, session)).toHaveLength(0);
  });

  it('a queue move does not stale', () => {
    const t = createTicket(db, { title: 'q', projectId: project, status: 'backlog' }).id;
    seedRound(db, session, [t]);
    updateTicket(db, t, { status: 'queue' });
    expect(staleTurns(db, session)).toHaveLength(0);
  });

  it('a session whose open round does NOT cite the changed ticket is left alone', () => {
    const other = createTicket(db, { title: 'other', projectId: project }).id;
    updateTicket(db, other, { status: 'closed' });
    expect(staleTurns(db, session)).toHaveLength(0);
  });

  it('two changes in quick succession produce exactly one stale turn (debounce)', () => {
    updateTicket(db, cited, { body: 'first rewrite' });
    updateTicket(db, cited, { status: 'closed' });
    expect(staleTurns(db, session)).toHaveLength(1);
  });

  it('a change never stales the changed ticket own session', () => {
    // session cites itself (should have been excluded at write time, but defend here too via self-id)
    seedRound(db, cited, [cited]);
    updateTicket(db, cited, { status: 'closed' });
    expect(staleTurns(db, cited)).toHaveLength(0);
  });
});

describe('approveRefine triggers stale fan-out (split / superseded)', () => {
  it('a decompose that closes the split parent stales sessions that cited the parent', () => {
    const db = freshDb();
    const project = pd(db);
    const parent = createTicket(db, { title: 'parent', projectId: project }).id;
    const session = createTicket(db, { title: 'session', projectId: project }).id;
    seedRound(db, session, [parent]);
    // Seed a decompose proposal on the parent and approve it → parent closes (split).
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      parent,
      REFINE_PROPOSAL_EVENT.proposal,
      JSON.stringify({
        mode: 'decompose',
        children: [{ title: 'child', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' }],
      } satisfies RefineProposal),
      Date.now(),
    );
    const res = approveRefine(db, parent);
    expect(res.ok).toBe(true);
    const stale = staleTurns(db, session);
    expect(stale).toHaveLength(1);
    expect((stale[0].detail as { change: string }).change).toBe('split');
  });

  it('a Populate that supersedes a member stales sessions that cited that member', () => {
    const db = freshDb();
    const project = pd(db);
    // An Epic with a member that will be superseded by the Populate.
    const epic = createTicket(db, { title: 'epic', projectId: project, isEpic: true });
    const member = createTicket(db, { title: 'old member', projectId: project, epicId: epic.id });
    const session = createTicket(db, { title: 'session', projectId: project }).id;
    seedRound(db, session, [member.id]);
    // A Populate on the Epic that supersedes the member → it closes with closeReason 'superseded'.
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      epic.id,
      REFINE_PROPOSAL_EVENT.proposal,
      JSON.stringify({
        mode: 'decompose',
        body: 'Epic reframed around its new members.',
        children: [{ title: 'new work', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' }],
        supersedes: [member.displayId!],
      } satisfies RefineProposal),
      Date.now(),
    );
    const res = approveRefine(db, epic.id);
    expect(res.ok).toBe(true);
    const stale = staleTurns(db, session);
    expect(stale).toHaveLength(1);
    expect((stale[0].detail as { change: string }).change).toBe('superseded');
    // The stale message reflects the superseded trigger, not a generic close.
    expect((stale[0].detail as { text: string }).text).toContain('has been superseded by other tickets');
  });
});

describe('answering a stale round is refused ROUND_STALE', () => {
  it('appendStructuredRefineReply returns round_stale once the round went stale', () => {
    const db = freshDb();
    const project = pd(db);
    const cited = createTicket(db, { title: 'cited', projectId: project }).id;
    const session = createTicket(db, { title: 'session', projectId: project }).id;
    seedRound(db, session, [cited]);
    // Answerable before the change.
    const before = appendStructuredRefineReply(db, session, { answers: [{ questionId: 'q1', choice: 0 }] });
    expect(before.ok).toBe(true);
    // Re-open a round and stale it.
    seedRound(db, session, [cited]);
    updateTicket(db, cited, { status: 'closed' });
    const after = appendStructuredRefineReply(db, session, { answers: [{ questionId: 'q1', choice: 0 }] });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('round_stale');
  });
});
