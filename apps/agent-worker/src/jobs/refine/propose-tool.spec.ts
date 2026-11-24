import Database from 'better-sqlite3';
import { beforeEach, describe, it, expect } from 'vitest';
import {
  REFINE_PROPOSAL_EVENT,
  latestActionableProposal,
  refineSupersedesError,
} from '@dashboard/shared';
import type { RefineProposal, TicketEvent } from '@dashboard/shared';
import { validateProposalShape } from './propose-tool.js';

const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

const CHILD = { title: 'c', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const };

describe('validateProposalShape', () => {
  it('rejects a decompose with no children key (the PD-273 slip)', () => {
    const p = { mode: 'decompose', rationale: 'too big' } as RefineProposal;
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('rejects a decompose with an empty children array', () => {
    const p: RefineProposal = { mode: 'decompose', children: [] };
    expect(validateProposalShape(p)).toMatch(/decompose requires a non-empty `children`/);
  });

  it('accepts a decompose with children routed to a pre-queue lane', () => {
    const p: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'backlog', assignee: 'robot' }],
    };
    expect(validateProposalShape(p)).toBeNull();
  });

  it('rejects a decompose child routed into a queue lane (D-057/D-058: Refine never queues)', () => {
    const robot: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'queue', assignee: 'robot' }],
    };
    expect(validateProposalShape(robot)).toMatch(/does not queue tickets/);
    const steve: RefineProposal = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'queue', assignee: 'steve' }],
    };
    expect(validateProposalShape(steve)).toMatch(/does not queue tickets/);
  });

  it('rejects a legacy robot_queue/steve_queue child status (PD-417)', () => {
    const robot = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'robot_queue', assignee: 'robot' }],
    } as unknown as RefineProposal;
    expect(validateProposalShape(robot)).toMatch(/does not queue tickets/);
    const steve = {
      mode: 'decompose',
      children: [{ title: 'c', body: ROBOT_BODY, status: 'steve_queue', assignee: 'steve' }],
    } as unknown as RefineProposal;
    expect(validateProposalShape(steve)).toMatch(/does not queue tickets/);
  });

  it('rejects a refine_in_place with no body', () => {
    const p: RefineProposal = { mode: 'refine_in_place', status: 'backlog' };
    expect(validateProposalShape(p)).toMatch(/refine_in_place requires the rewritten `body`/);
  });

  it('accepts a refine_in_place with a body (pre-queue lane or unset)', () => {
    expect(validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY })).toBeNull();
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'backlog' }),
    ).toBeNull();
  });

  it('rejects a refine_in_place routed into a queue lane (D-057/D-058)', () => {
    expect(
      validateProposalShape({ mode: 'refine_in_place', body: ROBOT_BODY, status: 'queue' }),
    ).toMatch(/does not queue tickets/);
  });
});

describe('validateProposalShape — a Populate carries the Epic body (PD-634)', () => {
  const children = [{ title: 'c', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const }];

  it('rejects a decompose on an Epic with no body, telling the agent what to send', () => {
    expect(validateProposalShape({ mode: 'decompose', children }, { targetIsEpic: true })).toMatch(
      /Populate requires the Epic's rewritten `body`/,
    );
    expect(validateProposalShape({ mode: 'decompose', body: '  ', children }, { targetIsEpic: true })).toMatch(
      /rewritten `body`/,
    );
  });

  it('accepts a decompose on an Epic that carries the rewritten body', () => {
    expect(validateProposalShape({ mode: 'decompose', body: 'Reframed.', children }, { targetIsEpic: true })).toBeNull();
  });

  it('does not require a body for a split of an ordinary ticket', () => {
    expect(validateProposalShape({ mode: 'decompose', children }, { targetIsEpic: false })).toBeNull();
    expect(validateProposalShape({ mode: 'decompose', children })).toBeNull();
  });

  it('accepts a child that opts out of being born refined', () => {
    const p: RefineProposal = { mode: 'decompose', children: [{ ...children[0], refined: false }] };
    expect(validateProposalShape(p)).toBeNull();
  });
});

describe('validateProposalShape — relations (PD-842)', () => {
  const kids = [
    { title: 'a', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const },
    { title: 'b', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const },
    { title: 'c', body: ROBOT_BODY, status: 'backlog' as const, assignee: 'robot' as const },
  ];

  it('accepts a blocks chain plus a relates edge', () => {
    const p: RefineProposal = {
      mode: 'decompose',
      children: kids,
      relations: [
        { from: 0, to: 1, type: 'blocks' },
        { from: 0, to: 2, type: 'blocks' },
        { from: 1, to: 2, type: 'relates' },
      ],
    };
    expect(validateProposalShape(p)).toBeNull();
  });

  it('rejects an index past the end of children', () => {
    const p: RefineProposal = { mode: 'decompose', children: kids, relations: [{ from: 0, to: 3, type: 'blocks' }] };
    expect(validateProposalShape(p)).toMatch(/index 3.*only 3 children/);
  });

  it('rejects a self-edge', () => {
    const p: RefineProposal = { mode: 'decompose', children: kids, relations: [{ from: 2, to: 2, type: 'relates' }] };
    expect(validateProposalShape(p)).toMatch(/itself/);
  });

  it('rejects a blocks cycle, but a relates loop is fine', () => {
    const cyc: RefineProposal = {
      mode: 'decompose',
      children: kids,
      relations: [
        { from: 0, to: 1, type: 'blocks' },
        { from: 1, to: 2, type: 'blocks' },
        { from: 2, to: 0, type: 'blocks' },
      ],
    };
    expect(validateProposalShape(cyc)).toMatch(/cycle \(0 → 1 → 2 → 0\)/);
    const loop: RefineProposal = {
      mode: 'decompose',
      children: kids,
      relations: [
        { from: 0, to: 1, type: 'relates' },
        { from: 1, to: 0, type: 'relates' },
      ],
    };
    expect(validateProposalShape(loop)).toBeNull();
  });

  it('rejects relations on refine_in_place', () => {
    const p: RefineProposal = { mode: 'refine_in_place', body: ROBOT_BODY, relations: [{ from: 0, to: 1, type: 'blocks' }] };
    expect(validateProposalShape(p)).toMatch(/refine_in_place/);
  });
});

describe('refineSupersedesError — the shared, board-free shape rule (PD-931)', () => {
  it('passes with no supersedes', () => {
    expect(refineSupersedesError(undefined, 'decompose')).toBeNull();
    expect(refineSupersedesError([], 'decompose')).toBeNull();
  });

  it('rejects any use on refine_in_place (there is nothing to supersede)', () => {
    expect(refineSupersedesError(['PD-200'], 'refine_in_place')).toMatch(/refine_in_place/);
  });

  it('rejects a malformed display id', () => {
    expect(refineSupersedesError(['nope'], 'decompose')).toMatch(/not a display id/);
    expect(refineSupersedesError(['PD-'], 'decompose')).toMatch(/not a display id/);
    expect(refineSupersedesError(['200'], 'decompose')).toMatch(/not a display id/);
  });

  it('rejects a duplicate, case-insensitively', () => {
    expect(refineSupersedesError(['PD-200', 'pd-200'], 'decompose')).toMatch(/more than once/);
  });

  it('accepts well-formed, unique ids on a decompose/Populate', () => {
    expect(refineSupersedesError(['PD-200', 'PD-201'], 'decompose')).toBeNull();
  });
});

describe('validateProposalShape — supersedes board validation (PD-931)', () => {
  let db: Database.Database;

  function add(
    id: number,
    displayId: string,
    over: Partial<{ status: string; epic: number | null; isEpic: boolean; archived: boolean }> = {},
  ) {
    db.prepare(
      `INSERT INTO agent_tickets (id, display_id, title, body, status, is_epic, epic_id, archived_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    ).run(
      id,
      displayId,
      displayId,
      over.status ?? 'backlog',
      over.isEpic ? 1 : 0,
      over.epic ?? null,
      over.archived ? 1 : null,
    );
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL, body TEXT,
        status TEXT NOT NULL, is_epic INTEGER NOT NULL DEFAULT 0, epic_id INTEGER, archived_at INTEGER);
    `);
    add(1, 'PD-100', { isEpic: true }); // the Epic being populated
    add(2, 'PD-200', { epic: 1 }); // an open member
    add(3, 'PD-201', { epic: 1, status: 'completed' });
    add(4, 'PD-202', { epic: 1, status: 'closed' });
    add(5, 'PD-300', { epic: null }); // a ticket under no Epic
    add(6, 'PD-400', { epic: 1 }); // an ordinary member, used as a plain-decompose target
    add(7, 'PD-500', { epic: null }); // a ticket under no Epic, used as a plain-decompose target
    add(8, 'PD-999', { epic: 1, archived: true }); // an archived member
  });

  // A Populate (decompose whose target is an Epic) must carry the Epic's rewritten body (PD-634).
  const populate = (supersedes?: string[]): RefineProposal => ({
    mode: 'decompose',
    body: 'Reframed Epic description.',
    children: [CHILD],
    ...(supersedes ? { supersedes } : {}),
  });
  const epicOpts = { targetIsEpic: true, targetTicketId: 1 };

  it('accepts an open member of the target Epic (Populate)', () => {
    expect(validateProposalShape(populate(['PD-200']), { ...epicOpts, board: db })).toBeNull();
  });

  it('resolves the display id case-insensitively', () => {
    expect(validateProposalShape(populate(['pd-200']), { ...epicOpts, board: db })).toBeNull();
  });

  it('rejects an id that names no open ticket (wrong id or archived)', () => {
    expect(validateProposalShape(populate(['PD-404']), { ...epicOpts, board: db })).toMatch(
      /no such open ticket/,
    );
    expect(validateProposalShape(populate(['PD-999']), { ...epicOpts, board: db })).toMatch(
      /no such open ticket/,
    );
  });

  it('rejects a terminal (completed/closed) member', () => {
    expect(validateProposalShape(populate(['PD-201']), { ...epicOpts, board: db })).toMatch(
      /already completed/,
    );
    expect(validateProposalShape(populate(['PD-202']), { ...epicOpts, board: db })).toMatch(
      /already closed/,
    );
  });

  it('rejects a ticket that is not a member of the target Epic', () => {
    expect(validateProposalShape(populate(['PD-300']), { ...epicOpts, board: db })).toMatch(
      /not a member of the Epic being populated/,
    );
  });

  it('resolves a plain decompose against the target ticket\'s own Epic', () => {
    // PD-400 is an ordinary member of Epic 1; a split of it keeps its children under that Epic,
    // so PD-200 (an open member of Epic 1) is a legal thing to supersede.
    const plain: RefineProposal = { mode: 'decompose', children: [CHILD], supersedes: ['PD-200'] };
    expect(validateProposalShape(plain, { targetIsEpic: false, targetTicketId: 6, board: db })).toBeNull();
  });

  it('rejects supersedes on a decompose that is under no Epic', () => {
    const plain: RefineProposal = { mode: 'decompose', children: [CHILD], supersedes: ['PD-200'] };
    expect(validateProposalShape(plain, { targetIsEpic: false, targetTicketId: 7, board: db })).toMatch(
      /is not under an Epic/,
    );
  });

  it('skips the board half entirely when no board handle is given', () => {
    // A well-formed supersedes passes the shared shape rule and is simply not resolved.
    expect(validateProposalShape(populate(['PD-404']))).toBeNull();
  });

  it('runs the shared shape rule before the board (a malformed id never hits the DB)', () => {
    expect(validateProposalShape(populate(['nope']), { ...epicOpts, board: db })).toMatch(
      /not a display id/,
    );
  });
});

describe('latestActionableProposal — a refine_superseded event terminates (PD-931)', () => {
  const ev = (id: number, type: string, detail?: unknown): TicketEvent => ({
    id,
    ticketId: 1,
    type,
    detail: detail ?? null,
    createdAt: id,
  });

  it('returns null once a refine_superseded event follows the proposal', () => {
    const events = [
      ev(1, REFINE_PROPOSAL_EVENT.proposal, { mode: 'refine_in_place', body: 'x' }),
      ev(2, REFINE_PROPOSAL_EVENT.superseded),
    ];
    expect(latestActionableProposal(events)).toBeNull();
  });

  it('still returns the proposal when nothing terminates it', () => {
    const events = [ev(1, REFINE_PROPOSAL_EVENT.proposal, { mode: 'refine_in_place', body: 'x' })];
    expect(latestActionableProposal(events)?.eventId).toBe(1);
  });
});
