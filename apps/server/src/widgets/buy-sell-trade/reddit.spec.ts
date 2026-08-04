import { beforeEach, describe, expect, it } from 'vitest';
import {
  RedditClient,
  assertReadOnlyEndpoint,
  looksLikeBstThread,
  readRedditConfig,
  type FetchLike,
  type RedditConfig,
  type RedditLogger,
} from './reddit';

// Every test drives an injected fetcher — nothing here touches the network.

const silent: RedditLogger = { info: () => {}, warn: () => {}, error: () => {} };

const config: RedditConfig = {
  clientId: 'cid',
  clientSecret: 'secret',
  userAgent: 'personal-dashboard-bst/1.0 by /u/tester',
  subreddit: 'modular',
  auth: { kind: 'refresh', refreshToken: 'rt' },
};

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** A fetcher driven by a url-substring → response map, recording every call. */
function stub(routes: [string, unknown][], calls: { url: string; init?: RequestInit }[] = []) {
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const [needle, body] of routes) if (url.includes(needle)) return json(body);
    return json({ error: 'unstubbed' }, 404);
  };
  return { fetchImpl, calls };
}

const TOKEN = ['/api/v1/access_token', { access_token: 'tok', expires_in: 3600 }] as [string, unknown];

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { children } });
const post = (over: Record<string, unknown> = {}) => ({
  kind: 't3',
  data: { id: 'abc123', title: 'Monthly Buy/Sell/Trade Thread', stickied: true, permalink: '/r/modular/comments/abc123/bst/', created_utc: 1, ...over },
});
const comment = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 't1',
  data: { id, author: `u${id}`, body: `body ${id}`, permalink: `/r/modular/comments/abc123/x/${id}/`, created_utc: 1, score: 1, ...over },
});

describe('readRedditConfig', () => {
  it('reports every missing var rather than throwing', () => {
    const r = readRedditConfig({});
    expect(r.configured).toBe(false);
    if (!r.configured) {
      expect(r.missing).toContain('REDDIT_CLIENT_ID');
      expect(r.missing).toContain('REDDIT_CLIENT_SECRET');
      expect(r.missing).toContain('REDDIT_USER_AGENT');
      expect(r.missing.some((m) => m.includes('REDDIT_REFRESH_TOKEN'))).toBe(true);
    }
  });

  it('accepts a refresh token', () => {
    const r = readRedditConfig({
      REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USER_AGENT: 'ua', REDDIT_REFRESH_TOKEN: 'rt',
    });
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.config.auth).toEqual({ kind: 'refresh', refreshToken: 'rt' });
  });

  it('accepts username + password as the fallback a fresh script app gives', () => {
    const r = readRedditConfig({
      REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USER_AGENT: 'ua',
      REDDIT_USERNAME: 'u', REDDIT_PASSWORD: 'p',
    });
    expect(r.configured).toBe(true);
    if (r.configured) expect(r.config.auth).toEqual({ kind: 'password', username: 'u', password: 'p' });
  });

  it('prefers the refresh token when both are set — the password grant dies under 2FA', () => {
    const r = readRedditConfig({
      REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USER_AGENT: 'ua',
      REDDIT_REFRESH_TOKEN: 'rt', REDDIT_USERNAME: 'u', REDDIT_PASSWORD: 'p',
    });
    if (r.configured) expect(r.config.auth.kind).toBe('refresh');
  });

  it('treats a half-set password pair as missing', () => {
    const r = readRedditConfig({
      REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USER_AGENT: 'ua', REDDIT_USERNAME: 'u',
    });
    expect(r.configured).toBe(false);
  });

  it('defaults the subreddit to modular but honours an override', () => {
    const base = { REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USER_AGENT: 'ua', REDDIT_REFRESH_TOKEN: 'rt' };
    const a = readRedditConfig(base);
    const b = readRedditConfig({ ...base, BST_SUBREDDIT: 'synthdiy' });
    if (a.configured) expect(a.config.subreddit).toBe('modular');
    if (b.configured) expect(b.config.subreddit).toBe('synthdiy');
  });

  it('ignores whitespace-only values', () => {
    expect(readRedditConfig({ REDDIT_CLIENT_ID: '   ' }).configured).toBe(false);
  });
});

// The read-only guarantee is the core promise of this module — and the one Steve's API
// access request makes to Reddit in writing. It is enforced, not merely intended.
describe('read-only guard', () => {
  it('allows GETs', () => {
    expect(() => assertReadOnlyEndpoint('https://oauth.reddit.com/r/modular/hot', 'GET')).not.toThrow();
  });

  it('allows the two POSTs Reddit itself requires', () => {
    expect(() => assertReadOnlyEndpoint('https://www.reddit.com/api/v1/access_token', 'POST')).not.toThrow();
    expect(() => assertReadOnlyEndpoint('https://oauth.reddit.com/api/morechildren', 'POST')).not.toThrow();
  });

  it('refuses every write endpoint', () => {
    for (const [url, method] of [
      ['https://oauth.reddit.com/api/comment', 'POST'],
      ['https://oauth.reddit.com/api/submit', 'POST'],
      ['https://oauth.reddit.com/api/vote', 'POST'],
      ['https://oauth.reddit.com/api/compose', 'POST'],
      ['https://oauth.reddit.com/api/del', 'POST'],
      ['https://oauth.reddit.com/api/editusertext', 'PUT'],
      ['https://oauth.reddit.com/r/modular/about/banned', 'DELETE'],
    ] as [string, string][]) {
      expect(() => assertReadOnlyEndpoint(url, method)).toThrow(/read-only/i);
    }
  });
});

describe('looksLikeBstThread', () => {
  it('matches the wordings the monthly title has actually used', () => {
    for (const t of [
      'Monthly Buy/Sell/Trade Thread — August 2026',
      'Buy, Sell, Trade thread',
      'BUY SELL TRADE - August',
      'August BST Thread',
      'Buy-Sell-Trade Megathread',
      'Buy and Sell Trade thread',
    ]) {
      expect(looksLikeBstThread(t)).toBe(true);
    }
  });

  it('does not match unrelated titles', () => {
    for (const t of [
      'Monthly Patch Thread',
      'What did you buy this week?',
      'Sell me on the Maths',
      // Prose that name-drops the thread without being it — word boundaries earn their keep.
      'Rules: no buying or selling outside the trade thread',
      undefined,
    ]) {
      expect(looksLikeBstThread(t)).toBe(false);
    }
  });
});

describe('RedditClient auth', () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    calls = [];
  });

  it('sends the refresh grant with basic auth and the configured user agent', async () => {
    const { fetchImpl } = stub([TOKEN], calls);
    const c = new RedditClient(config, fetchImpl, silent);
    expect(await c.accessToken()).toBe('tok');

    const tokenCall = calls[0];
    const headers = tokenCall.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(config.userAgent);
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(String(tokenCall.init?.body)).toContain('grant_type=refresh_token');
  });

  it('sends the password grant when configured that way', async () => {
    const { fetchImpl } = stub([TOKEN], calls);
    const pw = { ...config, auth: { kind: 'password', username: 'u', password: 'p' } } as RedditConfig;
    await new RedditClient(pw, fetchImpl, silent).accessToken();
    expect(String(calls[0].init?.body)).toContain('grant_type=password');
  });

  it('caches the token instead of re-authenticating every call', async () => {
    const { fetchImpl } = stub([TOKEN], calls);
    const c = new RedditClient(config, fetchImpl, silent);
    await c.accessToken();
    await c.accessToken();
    expect(calls.filter((x) => x.url.includes('access_token'))).toHaveLength(1);
  });

  it('re-authenticates once the token has expired', async () => {
    const { fetchImpl } = stub([TOKEN], calls);
    let clock = 1_000_000;
    const c = new RedditClient(config, fetchImpl, silent, () => clock);
    await c.accessToken();
    clock += 3600 * 1000; // past expiry
    await c.accessToken();
    expect(calls.filter((x) => x.url.includes('access_token'))).toHaveLength(2);
  });

  it('names 2FA as the likely cause when a password grant is rejected', async () => {
    const fetchImpl: FetchLike = async () => json({ error: 'invalid_grant' }, 400);
    const pw = { ...config, auth: { kind: 'password', username: 'u', password: 'p' } } as RedditConfig;
    await expect(new RedditClient(pw, fetchImpl, silent).accessToken()).rejects.toThrow(/2FA/i);
  });

  it('does not blame 2FA for a refresh-token failure', async () => {
    const fetchImpl: FetchLike = async () => json({ error: 'invalid_grant' }, 400);
    await expect(new RedditClient(config, fetchImpl, silent).accessToken()).rejects.not.toThrow(/2FA/i);
  });
});

describe('findBstThread', () => {
  it('prefers a stickied thread', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/hot', listing([post({ id: 'sticky1', stickied: true }), post({ id: 'other', stickied: false })])],
    ]);
    const t = await new RedditClient(config, fetchImpl, silent).findBstThread();
    expect(t?.id).toBe('sticky1');
    expect(t?.permalink).toMatch(/^https:\/\/www\.reddit\.com\//);
  });

  it('ignores a sticky whose title is not the BST thread', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { fetchImpl } = stub(
      [
        TOKEN,
        ['/hot', listing([post({ id: 'rules', title: 'Read the rules', stickied: true })])],
        ['/search', listing([post({ id: 'found' })])],
      ],
      calls,
    );
    const t = await new RedditClient(config, fetchImpl, silent).findBstThread();
    expect(t?.id).toBe('found');
    expect(calls.some((c) => c.url.includes('/search'))).toBe(true);
  });

  it('falls back to search when nothing is stickied — a sticky can be bumped', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/hot', listing([post({ id: 'x', stickied: false })])],
      ['/search', listing([post({ id: 'searched' })])],
    ]);
    expect((await new RedditClient(config, fetchImpl, silent).findBstThread())?.id).toBe('searched');
  });

  it('returns null rather than guessing when no thread matches', async () => {
    const { fetchImpl } = stub([TOKEN, ['/hot', listing([])], ['/search', listing([])]]);
    expect(await new RedditClient(config, fetchImpl, silent).findBstThread()).toBeNull();
  });

  it('queries the configured subreddit', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { fetchImpl } = stub([TOKEN, ['/hot', listing([post()])]], calls);
    await new RedditClient({ ...config, subreddit: 'synthdiy' }, fetchImpl, silent).findBstThread();
    expect(calls.some((c) => c.url.includes('/r/synthdiy/hot'))).toBe(true);
  });
});

describe('fetchComments', () => {
  it('flattens nested replies', async () => {
    const nested = comment('a1', {
      replies: listing([comment('b2', { replies: listing([comment('c3')]) })]),
    });
    const { fetchImpl } = stub([TOKEN, ['/comments/', [listing([]), listing([nested])]]]);
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments.map((c) => c.id).sort()).toEqual(['a1', 'b2', 'c3']);
  });

  it('drops deleted and removed bodies', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/comments/', [listing([]), listing([comment('ok'), comment('gone', { body: '[deleted]' }), comment('mod', { body: '[removed]' })])]],
    ]);
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments.map((c) => c.id)).toEqual(['ok']);
  });

  // The reason this ticket exists: without expansion the tail of a long thread is silently
  // missing, which looks like "the scanner never finds anything".
  it('expands `more` continuations', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/comments/', [listing([]), listing([comment('top'), { kind: 'more', data: { children: ['m1', 'm2'] } }])]],
      ['/api/morechildren', { json: { data: { things: [comment('m1'), comment('m2')] } } }],
    ]);
    const { comments, truncated } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments.map((c) => c.id).sort()).toEqual(['m1', 'm2', 'top']);
    expect(truncated).toBe(false);
  });

  it('follows a `more` nested inside a continuation response', async () => {
    let served = false;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('access_token')) return json({ access_token: 't', expires_in: 3600 });
      if (url.includes('/comments/')) {
        return json([listing([]), listing([{ kind: 'more', data: { children: ['x1'] } }])]);
      }
      if (!served) {
        served = true;
        return json({ json: { data: { things: [comment('x1'), { kind: 'more', data: { children: ['x2'] } }] } } });
      }
      return json({ json: { data: { things: [comment('x2')] } } });
    };
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments.map((c) => c.id).sort()).toEqual(['x1', 'x2']);
  });

  it('deduplicates a comment served by both the tree and a continuation', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/comments/', [listing([]), listing([comment('dup'), { kind: 'more', data: { children: ['dup'] } }])]],
      ['/api/morechildren', { json: { data: { things: [comment('dup')] } } }],
    ]);
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments).toHaveLength(1);
  });

  it('reports truncation instead of looping forever on a self-referential `more`', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('access_token')) return json({ access_token: 't', expires_in: 3600 });
      if (url.includes('/comments/')) return json([listing([]), listing([{ kind: 'more', data: { children: ['loop'] } }])]);
      return json({ json: { data: { things: [{ kind: 'more', data: { children: ['loop'] } }] } } });
    };
    const { truncated } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(truncated).toBe(true);
  });

  it('keeps the comments it has when a continuation request fails', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('access_token')) return json({ access_token: 't', expires_in: 3600 });
      if (url.includes('/comments/')) return json([listing([]), listing([comment('kept'), { kind: 'more', data: { children: ['lost'] } }])]);
      return json({ error: 'boom' }, 500);
    };
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments.map((c) => c.id)).toEqual(['kept']);
  });

  it('builds absolute permalinks', async () => {
    const { fetchImpl } = stub([TOKEN, ['/comments/', [listing([]), listing([comment('p1')])]]]);
    const { comments } = await new RedditClient(config, fetchImpl, silent).fetchComments('abc123');
    expect(comments[0].permalink).toBe('https://www.reddit.com/r/modular/comments/abc123/x/p1/');
  });
});

describe('scanCurrentThread', () => {
  it('returns the thread with its comments', async () => {
    const { fetchImpl } = stub([
      TOKEN,
      ['/hot', listing([post()])],
      ['/comments/', [listing([]), listing([comment('c1'), comment('c2')])]],
    ]);
    const scan = await new RedditClient(config, fetchImpl, silent).scanCurrentThread();
    expect(scan?.thread.id).toBe('abc123');
    expect(scan?.comments).toHaveLength(2);
  });

  it('returns null when no thread is found, rather than throwing', async () => {
    const { fetchImpl } = stub([TOKEN, ['/hot', listing([])], ['/search', listing([])]]);
    expect(await new RedditClient(config, fetchImpl, silent).scanCurrentThread()).toBeNull();
  });

  it('never issues a non-GET beyond token and morechildren', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const { fetchImpl } = stub(
      [TOKEN, ['/hot', listing([post()])], ['/comments/', [listing([]), listing([comment('c1')])]]],
      calls,
    );
    await new RedditClient(config, fetchImpl, silent).scanCurrentThread();
    for (const c of calls) {
      const method = (c.init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') expect(c.url).toMatch(/access_token|morechildren/);
    }
  });
});
