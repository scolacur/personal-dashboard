import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { createTicket, getProjectBySlug, getTicket, updateTicket } from './store';
import { deriveState, runGithubSync } from './github-sync';

const noopLog = { info() {}, error() {} };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function pdProjectId(db: Database.Database): number {
  const p = getProjectBySlug(db, 'personal-dashboard'); // seeded with github_repo
  if (!p) throw new Error('no personal-dashboard project');
  return p.id;
}

/** A fake fetch that returns the given issue payload for every call. */
function fakeFetch(issue: { state: 'open' | 'closed'; labels: string[] }, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ state: issue.state, labels: issue.labels.map((name) => ({ name })) }),
  })) as unknown as typeof fetch;
}

describe('deriveState', () => {
  it('maps each sortie:* label to the right status + agent state', () => {
    expect(deriveState(['sortie:in-progress'], 'open')).toEqual({ status: 'in_progress', agentState: 'working' });
    expect(deriveState(['sortie:in-review'], 'open')).toEqual({ status: 'in_review', agentState: null });
    expect(deriveState(['sortie:stuck'], 'open')).toEqual({ status: 'in_progress', agentState: 'stuck' });
    expect(deriveState(['sortie:needs-human'], 'open')).toEqual({ status: 'in_progress', agentState: 'needs-human' });
    expect(deriveState(['sortie:awaiting-human'], 'open')).toEqual({
      status: 'in_progress',
      agentState: 'awaiting-human',
    });
    expect(deriveState(['sortie:done'], 'open')).toEqual({ status: 'completed', agentState: null });
  });

  it('is case-insensitive on label names', () => {
    expect(deriveState(['SORTIE:IN-PROGRESS'], 'open')).toEqual({ status: 'in_progress', agentState: 'working' });
  });

  it('returns null when no rule applies (only queued / no sortie label)', () => {
    expect(deriveState(['sortie:queued'], 'open')).toBeNull();
    expect(deriveState([], 'open')).toBeNull();
    expect(deriveState(['bug', 'enhancement'], 'open')).toBeNull();
  });

  it('treats a closed issue with no terminal label as completed', () => {
    expect(deriveState([], 'closed')).toEqual({ status: 'completed', agentState: null });
  });

  it('treats closed as terminal — completed wins over a stale non-terminal label', () => {
    // An issue closed while still wearing an active label must NOT map to that label.
    expect(deriveState(['sortie:in-review'], 'closed')).toEqual({ status: 'completed', agentState: null });
    expect(deriveState(['sortie:in-progress'], 'closed')).toEqual({ status: 'completed', agentState: null });
    expect(deriveState(['sortie:stuck'], 'closed')).toEqual({ status: 'completed', agentState: null });
  });

  it('does NOT map sortie:wontfix (deferred to PD-193 / the closed status)', () => {
    // Open + wontfix only → no rule → null (status untouched).
    expect(deriveState(['sortie:wontfix'], 'open')).toBeNull();
  });

  it('applies precedence — stuck wins over in-progress', () => {
    expect(deriveState(['sortie:in-progress', 'sortie:stuck'], 'open')).toEqual({
      status: 'in_progress',
      agentState: 'stuck',
    });
  });
});

describe('runGithubSync', () => {
  it('writes derived status + agent state onto a linked ticket', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'linked', projectId: pdProjectId(db), status: 'queued' });
    updateTicket(db, t.id, { githubIssueNumber: 59, githubIssueUrl: 'https://x/59' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:in-progress'] }) });

    const after = getTicket(db, t.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.agentState).toBe('working');
  });

  it('skips tickets with no linked issue', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'unlinked', projectId: pdProjectId(db), status: 'ready' });
    // no updateTicket → githubIssueNumber stays null

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:in-progress'] }) });

    expect(getTicket(db, t.id)?.status).toBe('ready');
    expect(getTicket(db, t.id)?.agentState).toBeNull();
  });

  it('is a no-op when the derived state is unchanged (does not bump updated_at)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'x', projectId: pdProjectId(db), status: 'queued' });
    updateTicket(db, t.id, { githubIssueNumber: 60, githubIssueUrl: 'https://x/60' });
    const fetchImpl = fakeFetch({ state: 'open', labels: ['sortie:in-progress'] });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    const first = getTicket(db, t.id)!.updatedAt;
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    expect(getTicket(db, t.id)!.updatedAt).toBe(first);
  });

  it('leaves the ticket untouched on an HTTP error', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'err', projectId: pdProjectId(db), status: 'queued' });
    updateTicket(db, t.id, { githubIssueNumber: 61, githubIssueUrl: 'https://x/61' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: [] }, 404) });

    expect(getTicket(db, t.id)?.status).toBe('queued');
  });
});
