import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import { loadConfig } from '../../shared/config';
import { decideReactivation, parsePrUrl, pollInReviewPrs, type PrState, type PrFetcher } from './pr-state';
import { ensureRunsTable, startRun, finishRun } from './runs';
import { ensureRobotStateTable } from './state';

const EMPTY: PrState = { mergeable: 'MERGEABLE', reviewDecision: null, reviews: [], comments: [] };
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
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    db.prepare("INSERT INTO agent_tickets (id, status, agent_state) VALUES (1, 'robot_queue', 'in-review')").run();
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
