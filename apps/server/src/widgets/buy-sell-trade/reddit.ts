// Reddit client for the Buy/Sell/Trade widget (PD-471, epic PD-436).
//
// ─────────────────────────────────────────────────────────────────────────────
//  READ-ONLY. This module issues GET requests to oauth.reddit.com plus the two
//  POSTs required by Reddit's own API to obtain an access token and to expand
//  truncated comment threads (`/api/morechildren`, a read endpoint that is POST
//  only because the id list is too long for a query string).
//
//  It never posts, comments, replies, votes, messages, edits, deletes, follows,
//  subscribes, or modifies anything on Reddit. There is no code path here that
//  can write to the platform. `assertReadOnlyEndpoint` enforces that mechanically.
// ─────────────────────────────────────────────────────────────────────────────
//
// Single-user, pre-provisioned credentials via a "script" app, matching the
// inspirations-list Spotify client's pattern (D-060): config comes from env, and a
// missing/partial setup is reported rather than thrown so the server still boots.

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

/** Refresh this many seconds before real expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SKEW_SECONDS = 30;

/** Reddit caps `/api/morechildren` at 100 comment ids per request. */
const MORE_CHILDREN_CHUNK = 100;

/** Safety valve: stop expanding a thread after this many `more` round-trips. A BST thread
 *  runs to a few hundred comments, so this is generous; it exists so a malformed response
 *  can never spin the job forever. */
const MAX_MORE_REQUESTS = 40;

/** Minimal structural logger, so this module has no hard dependency on Fastify/pino. */
export interface RedditLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const defaultLogger: RedditLogger = {
  info: (m) => console.info(`[buy-sell-trade/reddit] ${m}`),
  warn: (m) => console.warn(`[buy-sell-trade/reddit] ${m}`),
  error: (m, e) => console.error(`[buy-sell-trade/reddit] ${m}`, e ?? ''),
};

/* ── Config ─────────────────────────────────────── */

/**
 * How to authenticate. A `script` app supports the password grant, but that breaks the
 * moment 2FA is enabled on the account (the OTP rotates and must be appended to the
 * password), which makes it unusable for a scheduled job. A refresh token has no such
 * problem, so it wins when both are configured.
 */
export type RedditAuth =
  | { kind: 'refresh'; refreshToken: string }
  | { kind: 'password'; username: string; password: string };

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  /** Reddit rate-limits or rejects generic agents; convention is `app/version by /u/user`. */
  userAgent: string;
  subreddit: string;
  auth: RedditAuth;
}

export type RedditConfigResult =
  | { configured: true; config: RedditConfig }
  | { configured: false; missing: string[] };

/**
 * Read credentials from the environment. Missing vars are *reported*, never thrown, so a
 * partial setup still boots — same convention as GITHUB_WRITE_TOKEN and the Spotify client.
 */
export function readRedditConfig(env: NodeJS.ProcessEnv = process.env): RedditConfigResult {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  const userAgent = env.REDDIT_USER_AGENT?.trim();
  const refreshToken = env.REDDIT_REFRESH_TOKEN?.trim();
  const username = env.REDDIT_USERNAME?.trim();
  const password = env.REDDIT_PASSWORD?.trim();
  const subreddit = env.BST_SUBREDDIT?.trim() || 'modular';

  const missing: string[] = [];
  if (!clientId) missing.push('REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!userAgent) missing.push('REDDIT_USER_AGENT');

  // Refresh token preferred; password grant accepted as the fallback a fresh script app gives.
  let auth: RedditAuth | null = null;
  if (refreshToken) {
    auth = { kind: 'refresh', refreshToken };
  } else if (username && password) {
    auth = { kind: 'password', username, password };
  } else {
    missing.push('REDDIT_REFRESH_TOKEN (or REDDIT_USERNAME + REDDIT_PASSWORD)');
  }

  if (!clientId || !clientSecret || !userAgent || !auth) return { configured: false, missing };
  return { configured: true, config: { clientId, clientSecret, userAgent, subreddit, auth } };
}

/* ── Domain shapes ──────────────────────────────── */

/** The seam between this ticket and the matcher (PD-438): the matcher consumes these and
 *  never knows they came from Reddit, so it stays testable against fixtures. */
export interface RedditComment {
  id: string;
  author: string;
  body: string;
  /** Absolute URL to the comment itself. */
  permalink: string;
  createdUtc: number;
  score: number;
}

export interface BstThread {
  id: string;
  title: string;
  permalink: string;
  createdUtc: number;
}

export interface ThreadScan {
  thread: BstThread;
  comments: RedditComment[];
  /** True when the `more` budget was hit — the scan is incomplete and the caller should say so
   *  rather than quietly reporting fewer matches than exist. */
  truncated: boolean;
}

/* ── HTTP ───────────────────────────────────────── */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Guard the read-only guarantee mechanically rather than by convention. Only the two
 * endpoints Reddit requires to be POSTs may be POSTed to; everything else must be a GET.
 * A future edit that tries to submit, vote or reply fails here rather than in production.
 */
const WRITE_SAFE_POST_PATHS = ['/api/v1/access_token', '/api/morechildren'];

export function assertReadOnlyEndpoint(url: string, method: string): void {
  const m = method.toUpperCase();
  if (m === 'GET') return;
  if (m === 'POST' && WRITE_SAFE_POST_PATHS.some((p) => url.includes(p))) return;
  throw new Error(
    `buy-sell-trade/reddit is read-only: refusing ${m} ${url}. ` +
      'Only token fetch and morechildren may be POSTed.',
  );
}

export class RedditClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: RedditConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly logger: RedditLogger = defaultLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every request goes through here, so the read-only guard cannot be bypassed. */
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    assertReadOnlyEndpoint(url, init.method ?? 'GET');
    return this.fetchImpl(url, {
      ...init,
      headers: { 'User-Agent': this.config.userAgent, ...(init.headers ?? {}) },
    });
  }

  /** Cached bearer token, refreshed a little before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;

    const { auth, clientId, clientSecret } = this.config;
    const body = new URLSearchParams(
      auth.kind === 'refresh'
        ? { grant_type: 'refresh_token', refresh_token: auth.refreshToken }
        : { grant_type: 'password', username: auth.username, password: auth.password },
    );

    const res = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      // 400 on a password grant is the classic 2FA symptom, so name it — it is otherwise a
      // baffling failure to debug.
      const hint =
        auth.kind === 'password' && (res.status === 400 || res.status === 401)
          ? ' (if the account has 2FA enabled, the password grant cannot work — use REDDIT_REFRESH_TOKEN)'
          : '';
      throw new Error(`reddit: token request failed ${res.status}${hint}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('reddit: token response had no access_token');

    const ttl = (json.expires_in ?? 3600) - EXPIRY_SKEW_SECONDS;
    this.token = { value: json.access_token, expiresAt: this.now() + ttl * 1000 };
    return this.token.value;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await this.request(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`reddit: GET ${path} failed ${res.status}`);
    return (await res.json()) as T;
  }

  /* ── Thread discovery ─────────────────────────── */

  /**
   * Find the subreddit's current Buy/Sell/Trade thread.
   *
   * Stickied posts first — r/modular pins the monthly thread, so that is both the cheapest
   * and the most reliable signal. Falls back to a title search sorted by new, because a
   * sticky can be bumped for an announcement at any time and the job must not simply give up.
   */
  async findBstThread(): Promise<BstThread | null> {
    const sub = this.config.subreddit;

    const hot = await this.apiGet<ListingResponse>(`/r/${sub}/hot?limit=15&raw_json=1`);
    const sticky = childrenOf(hot)
      .filter((c) => c.data.stickied)
      .find((c) => looksLikeBstThread(c.data.title));
    if (sticky) return toThread(sticky.data);

    this.logger.info(`no stickied BST thread in r/${sub}; falling back to title search`);
    const search = await this.apiGet<ListingResponse>(
      `/r/${sub}/search?q=${encodeURIComponent('title:"buy sell trade"')}` +
        '&restrict_sr=1&sort=new&limit=10&raw_json=1',
    );
    const hit = childrenOf(search).find((c) => looksLikeBstThread(c.data.title));
    return hit ? toThread(hit.data) : null;
  }

  /* ── Comments ─────────────────────────────────── */

  /**
   * Fetch a thread's full comment tree, expanding `more` continuations.
   *
   * The expansion is the whole point: a BST thread runs to several hundred comments and
   * Reddit truncates the initial payload. Without this the tail is silently missing, which
   * shows up as "the scanner never finds anything" rather than as an error.
   */
  async fetchComments(threadId: string): Promise<{ comments: RedditComment[]; truncated: boolean }> {
    const payload = await this.apiGet<[ListingResponse, ListingResponse]>(
      `/comments/${threadId}?limit=500&depth=10&raw_json=1`,
    );

    const comments: RedditComment[] = [];
    const pending: string[] = [];
    collect(payload[1], comments, pending);

    let requests = 0;
    let truncated = false;
    while (pending.length > 0) {
      if (requests >= MAX_MORE_REQUESTS) {
        this.logger.warn(
          `more-children budget (${MAX_MORE_REQUESTS}) exhausted on ${threadId}; ` +
            `${pending.length} continuation ids left unexpanded`,
        );
        truncated = true;
        break;
      }
      const chunk = pending.splice(0, MORE_CHILDREN_CHUNK);
      requests++;
      const more = await this.moreChildren(threadId, chunk);
      for (const thing of more) {
        if (thing.kind === 't1' && thing.data.body !== undefined) {
          comments.push(toComment(thing.data));
        } else if (thing.kind === 'more') {
          pending.push(...(thing.data.children ?? []));
        }
      }
    }

    // Reddit can return the same comment through both the tree and a continuation.
    const unique = [...new Map(comments.map((c) => [c.id, c])).values()];
    return { comments: unique, truncated };
  }

  /** POST only because the id list exceeds a practical query string; this is a read endpoint. */
  private async moreChildren(threadId: string, ids: string[]): Promise<Thing[]> {
    const token = await this.accessToken();
    const body = new URLSearchParams({
      api_type: 'json',
      link_id: `t3_${threadId}`,
      children: ids.join(','),
      limit_children: 'false',
      raw_json: '1',
    });
    const res = await this.request(`${API_BASE}/api/morechildren`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      // A failed continuation loses comments but should not lose the whole scan.
      this.logger.warn(`morechildren failed ${res.status} — continuing with what we have`);
      return [];
    }
    const json = (await res.json()) as { json?: { data?: { things?: Thing[] } } };
    return json.json?.data?.things ?? [];
  }

  /** Find the current BST thread and read it. `null` when no thread could be found. */
  async scanCurrentThread(): Promise<ThreadScan | null> {
    const thread = await this.findBstThread();
    if (!thread) {
      this.logger.warn(`no Buy/Sell/Trade thread found in r/${this.config.subreddit}`);
      return null;
    }
    const { comments, truncated } = await this.fetchComments(thread.id);
    this.logger.info(
      `scanned "${thread.title}" — ${comments.length} comments${truncated ? ' (truncated)' : ''}`,
    );
    return { thread, comments, truncated };
  }
}

/* ── Reddit wire shapes + helpers ───────────────── */

interface Thing {
  kind: string;
  data: {
    id?: string;
    author?: string;
    body?: string;
    permalink?: string;
    created_utc?: number;
    score?: number;
    title?: string;
    stickied?: boolean;
    children?: string[];
    replies?: ListingResponse | '';
  };
}

interface ListingResponse {
  kind?: string;
  data?: { children?: Thing[] };
}

function childrenOf(listing: ListingResponse): Thing[] {
  return listing?.data?.children ?? [];
}

/** Title test for the monthly thread. Deliberately loose on separators and wording — the
 *  title is hand-written each month and has varied ("Buy/Sell/Trade", "Buy, Sell, Trade",
 *  "BST Thread"). */
export function looksLikeBstThread(title: string | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/\bbst\b/.test(t)) return true;
  // Any separator (or "and") may appear between each pair: "buy/sell/trade", "buy, sell, trade",
  // "buy and sell trade", "buy sell and trade". Word boundaries keep prose like "buying or
  // selling outside the trade thread" from matching.
  return /\bbuy\b[\s/,|&-]*(?:and\s+)?\bsell\b[\s/,|&-]*(?:and\s+)?\btrade\b/.test(t);
}

function toThread(d: Thing['data']): BstThread {
  return {
    id: d.id ?? '',
    title: d.title ?? '',
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
    createdUtc: d.created_utc ?? 0,
  };
}

function toComment(d: Thing['data']): RedditComment {
  return {
    id: d.id ?? '',
    author: d.author ?? '[deleted]',
    body: d.body ?? '',
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
    createdUtc: d.created_utc ?? 0,
    score: d.score ?? 0,
  };
}

/** Walk a comment listing depth-first, collecting comments and queuing `more` ids. */
function collect(listing: ListingResponse, out: RedditComment[], pending: string[]): void {
  for (const thing of childrenOf(listing)) {
    if (thing.kind === 'more') {
      pending.push(...(thing.data.children ?? []));
      continue;
    }
    if (thing.kind !== 't1') continue;
    // Deleted/removed comments carry no body worth matching on.
    if (thing.data.body && thing.data.body !== '[deleted]' && thing.data.body !== '[removed]') {
      out.push(toComment(thing.data));
    }
    const replies = thing.data.replies;
    if (replies && typeof replies !== 'string') collect(replies, out, pending);
  }
}
