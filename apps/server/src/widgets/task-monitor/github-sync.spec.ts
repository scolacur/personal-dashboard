import { describe, it, expect } from 'vitest';
import { closeIssueNotPlanned, postIssueComment } from './github-sync';

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
  it('strips active legacy sortie:* labels, keeps other labels, and closes as not_planned', async () => {
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

  it('leaves non-active legacy sortie labels alone (e.g. sortie:in-review)', async () => {
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

describe('postIssueComment (PD-250 reply mirror)', () => {
  it('POSTs the comment body and returns true when GitHub accepts it', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const impl = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 201, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const ok = await postIssueComment('o/r', 12, 'hello', 'wtok', impl);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(/\/issues\/12\/comments$/.test(calls[0].url)).toBe(true);
    expect((calls[0].body as { body: string }).body).toBe('hello');
  });

  it('returns false when GitHub rejects the comment', async () => {
    const impl = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await postIssueComment('o/r', 13, 'x', 'wtok', impl)).toBe(false);
  });
});
