import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { createTicket, getProjectBySlug, getTicket, updateTicket } from './store';
import { deriveState, runGithubSync, runQueuedSync } from './github-sync';

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

/** A fetch mock for the queued-sync (create issue / read labels / add label). */
function queuedFetch(opts: { getLabels?: string[]; createNumber?: number }) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const impl = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'POST' && /\/issues$/.test(url)) {
      const n = opts.createNumber ?? 100;
      return { ok: true, status: 201, json: async () => ({ number: n, html_url: `https://gh/${n}` }) };
    }
    if (method === 'GET' && /\/issues\/\d+$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ state: 'open', labels: (opts.getLabels ?? []).map((name) => ({ name })) }) };
    }
    if (method === 'POST' && /\/labels$/.test(url)) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('runQueuedSync', () => {
  it('creates + labels + links an issue for an unlinked queued ticket', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'needs issue', projectId: pdProjectId(db), status: 'queued' });
    const { impl, calls } = queuedFetch({ createNumber: 200 });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    const after = getTicket(db, t.id);
    expect(after?.githubIssueNumber).toBe(200);
    expect(after?.githubIssueUrl).toBe('https://gh/200');
    const create = calls.find((c) => c.method === 'POST' && /\/issues$/.test(c.url));
    expect((create?.body as { labels: string[] }).labels).toContain('sortie:queued');
  });

  it('adds sortie:queued to a linked issue that has no sortie:* label yet', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'linked bare', projectId: pdProjectId(db), status: 'queued' });
    updateTicket(db, t.id, { githubIssueNumber: 50, githubIssueUrl: 'https://gh/50' });
    const { impl, calls } = queuedFetch({ getLabels: [] });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    const addLabel = calls.find((c) => c.method === 'POST' && /\/issues\/50\/labels$/.test(c.url));
    expect(addLabel).toBeDefined();
    expect((addLabel?.body as { labels: string[] }).labels).toContain('sortie:queued');
  });

  it('leaves a linked issue alone if it already has a sortie:* label', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'already moving', projectId: pdProjectId(db), status: 'queued' });
    updateTicket(db, t.id, { githubIssueNumber: 51, githubIssueUrl: 'https://gh/51' });
    const { impl, calls } = queuedFetch({ getLabels: ['sortie:in-progress'] });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    expect(calls.some((c) => /\/labels$/.test(c.url))).toBe(false);
  });

  it('skips non-queued tickets and non-sortie-enabled projects', async () => {
    const db = freshDb();
    createTicket(db, { title: 'ready one', projectId: pdProjectId(db), status: 'ready' }); // wrong lane
    const core = getProjectBySlug(db, 'core'); // sortie_enabled = 0
    if (core) createTicket(db, { title: 'core queued', projectId: core.id, status: 'queued' });
    const { impl, calls } = queuedFetch({ createNumber: 300 });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    expect(calls).toHaveLength(0);
  });
});
