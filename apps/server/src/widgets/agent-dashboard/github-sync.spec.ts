import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { createTicket, getProjectBySlug, getTicket, listNotifications, updateTicket } from './store';
import { closeIssueNotPlanned, deriveState, runGithubSync, runQueuedSync } from './github-sync';

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
  it('maps every non-terminal sortie:* label to robot_queue with the fine agentState (D-040)', () => {
    expect(deriveState(['sortie:queued'], 'open')).toEqual({ status: 'robot_queue', agentState: 'queued', assignee: 'robot' });
    expect(deriveState(['sortie:in-progress'], 'open')).toEqual({ status: 'robot_queue', agentState: 'working', assignee: 'robot' });
    expect(deriveState(['sortie:in-review'], 'open')).toEqual({ status: 'robot_queue', agentState: 'in-review' });
    expect(deriveState(['sortie:stuck'], 'open')).toEqual({ status: 'robot_queue', agentState: 'stuck', assignee: 'robot' });
    expect(deriveState(['sortie:needs-human'], 'open')).toEqual({ status: 'robot_queue', agentState: 'needs-human', assignee: 'robot' });
    expect(deriveState(['sortie:awaiting-human'], 'open')).toEqual({
      status: 'robot_queue',
      agentState: 'awaiting-human',
      assignee: 'robot',
    });
  });

  it('maps sortie:done to completed with a `done` agentState (green pill), open or closed', () => {
    // Terminal, but keeps agentState 'done' so the card shows a green pill. The closed
    // case must be checked before the generic closed→completed fallback (done issues are
    // usually closed on GitHub) — otherwise the agentState would be stripped to null.
    expect(deriveState(['sortie:done'], 'open')).toEqual({ status: 'completed', agentState: 'done' });
    expect(deriveState(['sortie:done'], 'closed')).toEqual({ status: 'completed', agentState: 'done' });
  });

  it('is case-insensitive on label names', () => {
    expect(deriveState(['SORTIE:IN-PROGRESS'], 'open')).toEqual({ status: 'robot_queue', agentState: 'working', assignee: 'robot' });
  });

  it('returns null only when no sortie:* label applies', () => {
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

  it('maps sortie:wontfix to board closed status (PD-193)', () => {
    expect(deriveState(['sortie:wontfix'], 'open')).toEqual({ status: 'closed', agentState: null });
  });

  it('sortie:wontfix wins over a closed GitHub issue state (maps to closed, not completed)', () => {
    // An issue closed as wontfix must land on board `closed`, not `completed`.
    expect(deriveState(['sortie:wontfix'], 'closed')).toEqual({ status: 'closed', agentState: null });
  });

  it('applies precedence — stuck wins over in-progress', () => {
    expect(deriveState(['sortie:in-progress', 'sortie:stuck'], 'open')).toEqual({
      status: 'robot_queue',
      agentState: 'stuck',
      assignee: 'robot',
    });
  });

});

describe('runGithubSync', () => {
  it('writes derived status + agent state onto a linked ticket', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'linked', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 59, githubIssueUrl: 'https://x/59' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:in-progress'] }) });

    const after = getTicket(db, t.id);
    expect(after?.status).toBe('robot_queue');
    expect(after?.agentState).toBe('working');
    expect(after?.assignee).toBe('robot');
  });

  it('auto-assigns to robot when issue has sortie:in-progress', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'unassigned', projectId: pdProjectId(db), status: 'robot_queue', assignee: 'steve' });
    updateTicket(db, t.id, { githubIssueNumber: 70, githubIssueUrl: 'https://x/70' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:in-progress'] }) });

    expect(getTicket(db, t.id)?.assignee).toBe('robot');
  });

  it('auto-assigns to robot when issue has only sortie:queued (no status change)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'queued ticket', projectId: pdProjectId(db), status: 'robot_queue', assignee: 'steve' });
    updateTicket(db, t.id, { githubIssueNumber: 71, githubIssueUrl: 'https://x/71' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:queued'] }) });

    const after = getTicket(db, t.id);
    expect(after?.assignee).toBe('robot');
    expect(after?.status).toBe('robot_queue');  // status unchanged
  });

  it('does not change assignee for non-agent labels (e.g. sortie:done)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'done', projectId: pdProjectId(db), status: 'robot_queue', assignee: 'steve' });
    updateTicket(db, t.id, { githubIssueNumber: 72, githubIssueUrl: 'https://x/72' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:done'] }) });

    expect(getTicket(db, t.id)?.status).toBe('completed');
    expect(getTicket(db, t.id)?.assignee).toBe('steve');  // unchanged
  });

  it('is a no-op for sortie:queued when assignee is already robot', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'already robot', projectId: pdProjectId(db), status: 'robot_queue', assignee: 'robot' });
    updateTicket(db, t.id, { githubIssueNumber: 73, githubIssueUrl: 'https://x/73' });
    const fetchImpl = fakeFetch({ state: 'open', labels: ['sortie:queued'] });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    const first = getTicket(db, t.id)!.updatedAt;
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    expect(getTicket(db, t.id)!.updatedAt).toBe(first);
  });

  it('skips tickets with no linked issue', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'unlinked', projectId: pdProjectId(db), status: 'prioritized' });
    // no updateTicket → githubIssueNumber stays null

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:in-progress'] }) });

    expect(getTicket(db, t.id)?.status).toBe('prioritized');
    expect(getTicket(db, t.id)?.agentState).toBeNull();
  });

  it('is a no-op when the derived state is unchanged (does not bump updated_at)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'x', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 60, githubIssueUrl: 'https://x/60' });
    const fetchImpl = fakeFetch({ state: 'open', labels: ['sortie:in-progress'] });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    const first = getTicket(db, t.id)!.updatedAt;
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    expect(getTicket(db, t.id)!.updatedAt).toBe(first);
  });

  it('leaves the ticket untouched on a transient HTTP error (5xx)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'err', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 61, githubIssueUrl: 'https://x/61' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: [] }, 500) });

    const after = getTicket(db, t.id);
    expect(after?.status).toBe('robot_queue');
    // A non-404 error must NOT unlink — the issue may still exist (rate limit / outage).
    expect(after?.githubIssueNumber).toBe(61);
  });

  it('unlinks the issue but keeps the ticket when the issue 404s (deleted on GitHub) — PD-207 C', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'deleted issue', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 500, githubIssueUrl: 'https://x/500' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: [] }, 404) });

    const after = getTicket(db, t.id);
    expect(after?.githubIssueNumber).toBeNull();
    expect(after?.githubIssueUrl).toBeNull();
    expect(after?.status).toBe('robot_queue'); // ticket itself is kept
  });

  it('sets a wontfix-labelled issue to board closed status', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'wontfix', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 62, githubIssueUrl: 'https://x/62' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'closed', labels: ['sortie:wontfix'] }) });

    expect(getTicket(db, t.id)?.status).toBe('closed');
    expect(getTicket(db, t.id)?.agentState).toBeNull();
  });

  it('reflects a sortie:stuck → sortie:awaiting-human label change (agentState transition)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'was stuck', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 65, githubIssueUrl: 'https://x/65' });
    // First sync: issue has sortie:stuck — sets agentState to 'stuck'.
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:stuck'] }) });
    expect(getTicket(db, t.id)?.agentState).toBe('stuck');
    // Second sync: label changed to sortie:awaiting-human — must update agentState.
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:awaiting-human'] }) });
    const after = getTicket(db, t.id);
    expect(after?.status).toBe('robot_queue');
    expect(after?.agentState).toBe('awaiting-human');
  });

  it('reflects a sortie:needs-human label on the board', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'needs human', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 66, githubIssueUrl: 'https://x/66' });
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:needs-human'] }) });
    const after = getTicket(db, t.id);
    expect(after?.status).toBe('robot_queue');
    expect(after?.agentState).toBe('needs-human');
  });

  it('sets a wontfix-labelled open issue to board closed status', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'wontfix open', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 67, githubIssueUrl: 'https://x/67' });
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: fakeFetch({ state: 'open', labels: ['sortie:wontfix'] }) });
    const after = getTicket(db, t.id);
    expect(after?.status).toBe('closed');
    expect(after?.agentState).toBeNull();
  });

  it('is a no-op when ticket is already in the target terminal status (idempotent)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'closed already', projectId: pdProjectId(db), status: 'closed' });
    updateTicket(db, t.id, { githubIssueNumber: 63, githubIssueUrl: 'https://x/63' });
    const fetchImpl = fakeFetch({ state: 'closed', labels: ['sortie:wontfix'] });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    const first = getTicket(db, t.id)!.updatedAt;
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl });
    expect(getTicket(db, t.id)!.updatedAt).toBe(first);
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
    const t = createTicket(db, { title: 'needs issue', projectId: pdProjectId(db), status: 'robot_queue' });
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
    const t = createTicket(db, { title: 'linked bare', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 50, githubIssueUrl: 'https://gh/50' });
    const { impl, calls } = queuedFetch({ getLabels: [] });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    const addLabel = calls.find((c) => c.method === 'POST' && /\/issues\/50\/labels$/.test(c.url));
    expect(addLabel).toBeDefined();
    expect((addLabel?.body as { labels: string[] }).labels).toContain('sortie:queued');
  });

  it('leaves a linked issue alone if it already has a sortie:* label', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'already moving', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 51, githubIssueUrl: 'https://gh/51' });
    const { impl, calls } = queuedFetch({ getLabels: ['sortie:in-progress'] });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    expect(calls.some((c) => /\/labels$/.test(c.url))).toBe(false);
  });

  it('skips non-queued tickets and non-sortie-enabled projects', async () => {
    const db = freshDb();
    createTicket(db, { title: 'ready one', projectId: pdProjectId(db), status: 'prioritized' }); // wrong lane
    const core = getProjectBySlug(db, 'core'); // sortie_enabled = 0
    if (core) createTicket(db, { title: 'core queued', projectId: core.id, status: 'robot_queue' });
    const { impl, calls } = queuedFetch({ createNumber: 300 });

    await runQueuedSync({ db, token: 'wtok', log: noopLog, fetchImpl: impl });

    expect(calls).toHaveLength(0);
  });
});

/** A fetch mock for closeIssueNotPlanned: a GET returning `labels`, then a PATCH. */
function closeFetch(opts: { labels?: string[]; getStatus?: number; patchOk?: boolean }) {
  const calls: { method: string; body: Record<string, unknown> | undefined }[] = [];
  const impl = (async (_url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'GET') {
      const status = opts.getStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ state: 'open', labels: (opts.labels ?? []).map((name) => ({ name })) }),
      };
    }
    return { ok: opts.patchOk ?? true, status: opts.patchOk === false ? 500 : 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('closeIssueNotPlanned (PD-207 A)', () => {
  it('strips active sortie:* labels, keeps other labels, and closes as not_planned', async () => {
    const { impl, calls } = closeFetch({ labels: ['sortie:queued', 'bug'] });

    const ok = await closeIssueNotPlanned('o/r', 7, 'wtok', impl);

    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(patch?.body?.labels).toEqual(['bug']); // sortie:queued removed, bug preserved
  });

  it('also strips sortie:in-progress (case-insensitive)', async () => {
    const { impl, calls } = closeFetch({ labels: ['SORTIE:IN-PROGRESS', 'enhancement'] });

    await closeIssueNotPlanned('o/r', 8, 'wtok', impl);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body?.labels).toEqual(['enhancement']);
  });

  it('leaves non-active sortie labels alone (e.g. sortie:in-review)', async () => {
    const { impl, calls } = closeFetch({ labels: ['sortie:in-review'] });

    await closeIssueNotPlanned('o/r', 9, 'wtok', impl);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body?.labels).toEqual(['sortie:in-review']); // in-review is not a dispatch label
  });

  it('still closes (labels untouched) when the label GET fails', async () => {
    const { impl, calls } = closeFetch({ getStatus: 500 });

    const ok = await closeIssueNotPlanned('o/r', 10, 'wtok', impl);

    expect(ok).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    expect(patch?.body?.labels).toBeUndefined(); // no label rewrite attempted
  });

  it('returns false when the close PATCH is rejected', async () => {
    const { impl } = closeFetch({ labels: ['sortie:queued'], patchOk: false });

    expect(await closeIssueNotPlanned('o/r', 11, 'wtok', impl)).toBe(false);
  });
});

describe('runGithubSync — park notifications (PD-250)', () => {
  // Distinguishes the issue GET (labels) from the comments GET (ask_human question).
  function parkFetch(question: string | null): typeof fetch {
    return (async (url: string) => {
      if (/\/comments/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => (question === null ? [] : [{ body: `### ❓ ask_human\n\n${question}` }]),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: 'open', labels: [{ name: 'sortie:awaiting-human' }] }),
      };
    }) as unknown as typeof fetch;
  }

  it('creates a notification with the ask_human question when a ticket newly parks', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'parking', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 80, githubIssueUrl: 'https://x/80' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: parkFetch('Which color — blue or green?') });

    const notes = listNotifications(db);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe('agent_awaiting_human');
    expect(notes[0].ticketId).toBe(t.id);
    expect(notes[0].body).toBe('Which color — blue or green?');
  });

  it('does not create a second notification while still parked (dedup across polls)', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'parking', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 81, githubIssueUrl: 'https://x/81' });
    const impl = parkFetch('Q?');

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: impl });
    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: impl });

    expect(listNotifications(db)).toHaveLength(1);
  });

  it('falls back to a generic body when no ask_human comment is found', async () => {
    const db = freshDb();
    const t = createTicket(db, { title: 'parking', projectId: pdProjectId(db), status: 'robot_queue' });
    updateTicket(db, t.id, { githubIssueNumber: 82, githubIssueUrl: 'https://x/82' });

    await runGithubSync({ db, token: 'tok', log: noopLog, fetchImpl: parkFetch(null) });

    const notes = listNotifications(db);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('needs your input');
  });
});
