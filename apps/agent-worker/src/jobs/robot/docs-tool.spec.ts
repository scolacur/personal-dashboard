import { describe, it, expect, vi } from 'vitest';
import {
  DOCS_FETCH_TOOL_NAME,
  MAX_REDIRECTS,
  MAX_TEXT_CHARS,
  fetchDoc,
  htmlToText,
  offBaselineGuidance,
  workerSecrets,
} from './docs-tool';
import { ROBOT_TOOLS } from './session';

/** A `fetch` stand-in driven by a URL → Response map. Nothing here touches the network. */
function fakeFetch(routes: Record<string, Response | (() => Response)>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    const hit = routes[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return typeof hit === 'function' ? hit() : hit;
  }) as unknown as typeof fetch;
}

const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('fetchDoc — the happy path', () => {
  it('fetches a baseline doc page with GET and no credentials attached', async () => {
    const impl = fakeFetch({ 'https://svelte.dev/docs/kit': html('<h1>Routing</h1><p>Hello</p>') });
    const r = await fetchDoc('https://svelte.dev/docs/kit', { fetchImpl: impl, secrets: [] });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Routing');

    const init = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    // The structural guarantee: the worker builds the request, so there is no auth header to strip.
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(init.body).toBeUndefined();
  });

  it('truncates a very long page rather than flooding the agent context', async () => {
    const impl = fakeFetch({ 'https://svelte.dev/docs/big': html('<p>' + 'x'.repeat(MAX_TEXT_CHARS * 2) + '</p>') });
    const r = await fetchDoc('https://svelte.dev/docs/big', { fetchImpl: impl, secrets: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(r.truncated).toBe(true);
    }
  });
});

describe('fetchDoc — redirects', () => {
  it('follows a redirect that stays on the allowlist', async () => {
    const impl = fakeFetch({
      'https://svelte.dev/docs': redirect('https://kit.svelte.dev/docs/routing'),
      'https://kit.svelte.dev/docs/routing': html('<p>Routing</p>'),
    });
    const r = await fetchDoc('https://svelte.dev/docs', { fetchImpl: impl, secrets: [] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://kit.svelte.dev/docs/routing');
  });

  it('does NOT follow a redirect off the allowlist', async () => {
    // The classic way around a domain allowlist. `fetch`'s default redirect:'follow' would take
    // this silently and report a 200, so the caller would never learn where the bytes came from.
    const impl = fakeFetch({
      'https://svelte.dev/docs': redirect('https://evil.example.com/collect'),
      'https://evil.example.com/collect': html('<p>should never be requested</p>'),
    });
    const r = await fetchDoc('https://svelte.dev/docs', { fetchImpl: impl, secrets: [] });

    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error).toMatch(/evil\.example\.com/);
    const calls = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls).not.toContain('https://evil.example.com/collect');
  });

  it('re-applies the URL rules on each hop, not just the allowlist', async () => {
    // An allowlisted host redirecting to an allowlisted host WITH a query string still carries data.
    const impl = fakeFetch({
      'https://svelte.dev/docs': redirect('https://svelte.dev/search?q=leak'),
    });
    const r = await fetchDoc('https://svelte.dev/docs', { fetchImpl: impl, secrets: [] });
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error).toMatch(/query string/i);
  });

  it('gives up on a redirect loop instead of spinning', async () => {
    const impl = fakeFetch({
      'https://svelte.dev/a': () => redirect('https://svelte.dev/b'),
      'https://svelte.dev/b': () => redirect('https://svelte.dev/a'),
    });
    const r = await fetchDoc('https://svelte.dev/a', { fetchImpl: impl, secrets: [] });
    expect(r.ok).toBe(false);
    if (!r.ok && 'error' in r) expect(r.error).toMatch(/Too many redirects/);
    expect((impl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
  });
});

describe('fetchDoc — refusals never reach the network', () => {
  it('refuses an off-baseline host without making a request', async () => {
    const impl = fakeFetch({});
    const r = await fetchDoc('https://evil.example.com/docs', { fetchImpl: impl, secrets: [] });
    expect(r.ok).toBe(false);
    if (!r.ok && 'refusal' in r) expect(r.refusal.code).toBe('off-baseline');
    expect((impl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('refuses a URL carrying a live credential without making a request', async () => {
    const impl = fakeFetch({});
    const token = 'synthetic-token-value-abcdefgh';
    const r = await fetchDoc(`https://svelte.dev/docs/${token}`, { fetchImpl: impl, secrets: [token] });
    expect(r.ok).toBe(false);
    if (!r.ok && 'refusal' in r) expect(r.refusal.code).toBe('secret-in-url');
    // The point of refusing before dispatch: the token never leaves the process.
    expect((impl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('workerSecrets', () => {
  it('collects the worker credentials and drops unset ones', () => {
    const secrets = workerSecrets({ GH_TOKEN: 'aaaa', ANTHROPIC_API_KEY: '', GITHUB_TOKEN: undefined } as NodeJS.ProcessEnv);
    expect(secrets).toEqual(['aaaa']);
  });
});

describe('htmlToText', () => {
  it('drops script and style bodies entirely', () => {
    const text = htmlToText('<style>.a{color:red}</style><script>steal()</script><p>Real content</p>');
    expect(text).toContain('Real content');
    expect(text).not.toContain('steal()');
    expect(text).not.toContain('color:red');
  });

  it('decodes the entities that actually show up in prose', () => {
    expect(htmlToText('<p>a &amp; b &lt;T&gt; &quot;q&quot;</p>')).toBe('a & b <T> "q"');
  });
});

describe('the tool surface', () => {
  it('is an MCP tool, so D-068\'s built-in allowlist is unchanged', () => {
    // PD-310 does NOT reopen D-068. `tools` governs built-in tools; this one arrives via
    // `mcpServers`. If that ever stops being true the fix is to add the name below to ROBOT_TOOLS —
    // but WebFetch must still stay out.
    expect(DOCS_FETCH_TOOL_NAME).toBe('mcp__docs__fetch');
    expect(ROBOT_TOOLS).not.toContain('WebFetch');
    expect(ROBOT_TOOLS).not.toContain('WebSearch');
    expect(ROBOT_TOOLS).not.toContain(DOCS_FETCH_TOOL_NAME);
  });

  it('routes an off-baseline refusal to ask_human rather than to a retry', () => {
    // A bare "denied" reliably produces one of two bad outcomes: a retry loop, or abandoning the
    // ticket over a doc page. The guidance names both and rules them out.
    const g = offBaselineGuidance('example.com');
    expect(g).toMatch(/Do NOT retry/);
    expect(g).toMatch(/\.robot\/ask-human/);
    expect(g).toMatch(/does not count against the ticket/);
  });
});
