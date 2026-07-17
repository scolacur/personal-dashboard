import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { loadConfig } from '../../shared/config';
import { decideReactivation, parsePrUrl, pollInReviewPrs, type PrState, type PrFetcher } from './pr-state';
import { ensureRunsTable, startRun, finishRun } from './runs';
import { ensureRobotStateTable } from './state';

const EMPTY: PrState = { state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null, reviews: [], comments: [], inlineComments: [] };
const iso = (ms: number): string => new Date(ms).toISOString();

describe('parsePrUrl', () => {
  it('extracts owner/repo + number', () => {
    expect(parsePrUrl('https://github.com/scolacur/personal-dashboard/pull/314')).toEqual({
      repo: 'scolacur/personal-dashboard',
      prNumber: 314,
    });
  });
  it('returns null for junk / null', () => {
    expect(parsePrUrl(null)).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });
});

describe('decideReactivation', () => {
  const boundary = 1000;

  it('does not react to a pure APPROVED review', () => {
    const pr: PrState = { ...EMPTY, reviews: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', state: 'APPROVED', body: '', submittedAt: iso(2000) }] };
    expect(decideReactivation(pr, boundary).reactivate).toBe(false);
  });

  it('reacts to an owner CHANGES_REQUESTED review after the boundary', () => {
    const pr: PrState = { ...EMPTY, reviews: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', body: 'fix it', submittedAt: iso(2000) }] };
    expect(decideReactivation(pr, boundary)).toMatchObject({ reactivate: true, reason: 'review' });
  });

  it('ignores a review that predates the last hand-off (stale, no re-trigger loop)', () => {
    const pr: PrState = { ...EMPTY, reviews: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', state: 'CHANGES_REQUESTED', body: 'x', submittedAt: iso(500) }] };
    expect(decideReactivation(pr, boundary).reactivate).toBe(false);
  });

  it('reacts to an owner COMMENTED review with a body, but not an empty one', () => {
    const withBody: PrState = { ...EMPTY, reviews: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', state: 'COMMENTED', body: 'thoughts', submittedAt: iso(2000) }] };
    expect(decideReactivation(withBody, boundary).reactivate).toBe(true);
    const empty: PrState = { ...EMPTY, reviews: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', state: 'COMMENTED', body: '', submittedAt: iso(2000) }] };
    expect(decideReactivation(empty, boundary).reactivate).toBe(false);
  });

  it('reacts to a trusted top-level PR comment (owner, or collaborator with the marker)', () => {
    const owner: PrState = { ...EMPTY, comments: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', body: 'please tweak', createdAt: iso(2000) }] };
    expect(decideReactivation(owner, boundary)).toMatchObject({ reactivate: true, reason: 'comment' });

    const botNoMarker: PrState = { ...EMPTY, comments: [{ authorLogin: 'bot', authorAssociation: 'COLLABORATOR', body: 'no marker', createdAt: iso(2000) }] };
    expect(decideReactivation(botNoMarker, boundary).reactivate).toBe(false);

    const forwarded: PrState = { ...EMPTY, comments: [{ authorLogin: 'bot', authorAssociation: 'COLLABORATOR', body: `steve says: redo it\n\n${HUMAN_REPLY_MARKER}`, createdAt: iso(2000) }] };
    expect(decideReactivation(forwarded, boundary).reactivate).toBe(true);
  });

  it('reacts to a trusted inline diff comment (PD-394 — gh pr view misses these)', () => {
    const owner: PrState = { ...EMPTY, inlineComments: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', body: 'tighten this line', createdAt: iso(2000) }] };
    expect(decideReactivation(owner, boundary)).toMatchObject({ reactivate: true, reason: 'comment' });
  });

  it('ignores an inline comment that is stale, empty, or from an untrusted author', () => {
    const stale: PrState = { ...EMPTY, inlineComments: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', body: 'x', createdAt: iso(500) }] };
    expect(decideReactivation(stale, boundary).reactivate).toBe(false);
    const empty: PrState = { ...EMPTY, inlineComments: [{ authorLogin: 'scolacur', authorAssociation: 'OWNER', body: '  ', createdAt: iso(2000) }] };
    expect(decideReactivation(empty, boundary).reactivate).toBe(false);
    const stranger: PrState = { ...EMPTY, inlineComments: [{ authorLogin: 'rando', authorAssociation: 'NONE', body: 'do this', createdAt: iso(2000) }] };
    expect(decideReactivation(stranger, boundary).reactivate).toBe(false);
  });

  it('reacts to a merge conflict', () => {
    const pr: PrState = { ...EMPTY, mergeable: 'CONFLICTING' };
    expect(decideReactivation(pr, boundary)).toMatchObject({ reactivate: true, reason: 'conflict' });
  });

  it('does nothing for a clean, feedback-free PR', () => {
    expect(decideReactivation(EMPTY, boundary).reactivate).toBe(false);
  });
});

describe('pollInReviewPrs', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    db.prepare("INSERT INTO agent_tickets (id, status, assignee, agent_state) VALUES (1, 'queue', 'robot', 'in-review')").run();
    const runId = startRun(db, { ticketId: 1, issueNumber: 220, branch: 'robot/220' }, 10);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
  });

  const cfg = () => loadConfig({ ROBOT_PR_POLL_INTERVAL_MS: '0' });

  it('re-activates an in-review ticket whose PR conflicts, logging robot_reactivated', async () => {
    const fetcher: PrFetcher = async () => ({ ...EMPTY, mergeable: 'CONFLICTING' });
    const n = await pollInReviewPrs(db, cfg(), 5000, fetcher);
    expect(n).toBe(1);
    expect((db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = 1').get() as { s: string }).s).toBe('queued');
    const types = (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_reactivated');
  });

  it('leaves a clean in-review ticket alone', async () => {
    const fetcher: PrFetcher = async () => EMPTY;
    const n = await pollInReviewPrs(db, cfg(), 5000, fetcher);
    expect(n).toBe(0);
    expect((db.prepare('SELECT agent_state AS s FROM agent_tickets WHERE id = 1').get() as { s: string }).s).toBe('in-review');
  });

  it('completes an in-review ticket whose PR merged, logging robot_completed (C6/PD-347)', async () => {
    const fetcher: PrFetcher = async () => ({ ...EMPTY, state: 'MERGED' });
    const n = await pollInReviewPrs(db, cfg(), 5000, fetcher);
    expect(n).toBe(0); // terminal transitions are side effects, not counted as re-activations
    const row = db.prepare('SELECT status AS st, agent_state AS ag FROM agent_tickets WHERE id = 1').get() as { st: string; ag: string };
    expect(row.st).toBe('completed');
    expect(row.ag).toBe('done');
    const types = (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_completed');
  });

  it('parks an in-review ticket needs-human when its PR was closed unmerged (C6/PD-347)', async () => {
    const fetcher: PrFetcher = async () => ({ ...EMPTY, state: 'CLOSED' });
    const n = await pollInReviewPrs(db, cfg(), 5000, fetcher);
    expect(n).toBe(0);
    const row = db.prepare('SELECT status AS st, agent_state AS ag FROM agent_tickets WHERE id = 1').get() as { st: string; ag: string };
    expect(row.st).toBe('queue'); // stays in the lane; it's a park, not a terminal
    expect(row.ag).toBe('needs-human');
    const types = (db.prepare('SELECT type FROM agent_ticket_events WHERE ticket_id = 1').all() as { type: string }[]).map((r) => r.type);
    expect(types).toContain('robot_pr_closed');
    const notif = db.prepare("SELECT kind AS k FROM agent_notifications WHERE ticket_id = 1").get() as { k: string } | undefined;
    expect(notif?.k).toBe('agent_needs_human');
  });

  it('throttles: a second poll within the interval does no work', async () => {
    let calls = 0;
    const fetcher: PrFetcher = async () => {
      calls++;
      return EMPTY;
    };
    const config = loadConfig({ ROBOT_PR_POLL_INTERVAL_MS: '60000' });
    await pollInReviewPrs(db, config, 1_000_000, fetcher);
    await pollInReviewPrs(db, config, 1_000_001, fetcher); // within 60s of the first
    expect(calls).toBe(1);
  });
});
