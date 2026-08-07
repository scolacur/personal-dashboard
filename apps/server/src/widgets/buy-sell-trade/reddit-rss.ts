import type { BstCommentInput } from '@dashboard/shared';
import { looksLikeBstThread } from './reddit';

/**
 * Read r/modular over Reddit's **public Atom feeds** (PD-471, rewritten 2026-08-06).
 *
 * ## Why not the Data API
 *
 * Steve's Data API application was declined with a boilerplate "not in compliance and/or lacks
 * necessary details" and no appeal path — the reported norm in 2026 for read-only non-commercial
 * projects. The RSS feeds need no application, no OAuth, and no credentials of any kind, and were
 * verified working from the NAS the same day. `reddit.ts`'s `RedditClient` is parked, not deleted:
 * it is tested and immediately useful if access is ever granted.
 *
 * ## The rules this plays by
 *
 * These are **public feeds, not the sanctioned API**, so the obligations are: a descriptive
 * User-Agent, and staying inside the published rate limit. Reddit cut RSS to roughly **one request
 * per minute** in June 2025 (a ~97% reduction, with no announcement). A weekly scan needs three
 * requests, so the limit is not a constraint — but the fact that it moved silently once is exactly
 * why nothing here treats a bad response as an empty one.
 *
 * ## FAIL LOUDLY
 *
 * The failure this feature cannot afford is reporting **"no matches"** when it actually saw
 * nothing. `no offers this week` and `Reddit returned 429` must never look alike. Every degraded
 * path below throws `RedditFeedError` rather than returning an empty array, and the caller
 * surfaces it. There is deliberately no "best effort, return what we got" mode.
 */

/** A feed request or parse that could not complete. Never swallowed, never coerced to `[]`. */
export class RedditFeedError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'shape' | 'empty' | 'not-found',
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RedditFeedError';
  }
}

/**
 * Identifies this app to Reddit. Required, and in Reddit's documented format — a missing or
 * generic User-Agent is the most common cause of a 429 on an otherwise correct request.
 */
export const USER_AGENT = 'linux:personal-dashboard-bst:0.2 (by /u/scolacur)';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Minimum gap between requests, in ms.
 *
 * **Measured, not guessed** (2026-08-06, from the NAS): two feed requests 3s apart both
 * returned 200, a third 3s later returned **429**, and every request spaced ~70s apart
 * returned 200. So the limit tolerates a small burst and then throttles hard.
 *
 * This matters more than it looks: one scan is three requests (search + two threads). Without
 * pacing, every real scan would 429 partway and report `partial` **forever** — the feature would
 * look broken in exactly the way the loud-failure work is designed to reveal. Two minutes is
 * nothing for a weekly job.
 *
 * Set to 0 when `feedAuth` is supplied — the account-scoped params restore the pre-2025 rate.
 */
export const DEFAULT_REQUEST_GAP_MS = 70_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RedditRssOptions {
  subreddit?: string;
  fetchImpl?: FetchLike;
  /** Override the pacing. Tests pass 0; production should not, unless `feedAuth` is set. */
  requestGapMs?: number;
  /** Injected so tests do not actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Account-scoped feed credentials from Reddit's own preferences page (`user=` / `feed=`),
   * which restore the pre-2025 rate limit. Optional, and **not an API key** — no application,
   * no review. Absent, we simply stay inside the public limit.
   */
  feedAuth?: { user: string; feed: string } | null;
}

/* ── Atom parsing ───────────────────────────────── */

/**
 * Minimal Atom reader, hand-rolled rather than a new dependency.
 *
 * Justified because the input is one machine-generated feed shape, and because the alternative
 * costs a dependency on a **sensitive path** (`package.json`) for ~40 lines. The trade is that a
 * shape change must be *detected*, not silently tolerated — hence `parseFeed` throwing on a
 * document with no `<feed>` root, and every field extraction being explicit about what it wants.
 */
export interface FeedEntry {
  /** Reddit fullname: `t1_xxx` for a comment, `t3_xxx` for a submission. */
  id: string;
  title: string;
  /** `/u/name` as the feed writes it, or '' when absent. */
  author: string;
  link: string;
  updated: string;
  /** Escaped HTML as it appears in the feed; use `htmlToText` before matching on it. */
  contentHtml: string;
}

function tag(entry: string, name: string): string {
  const m = entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode XML/HTML entities, including the numeric forms Reddit uses heavily (`&#39;`). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

/**
 * Comment bodies arrive as escaped HTML (`&lt;p&gt;WTS/WTT&lt;/p&gt;`). Unwrap to plain text,
 * **preserving line structure**: each block element becomes a newline, because the matcher's
 * corroboration rule is per line item (D-065's PD-475 amendment) and flattening a comment's
 * bullets into one line would let any manufacturer vouch for any module in it.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    decodeEntities(html)
      // Reddit wraps each paragraph/list item in its own block — those are the line items.
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** Split a feed document into entries, failing loudly on anything that is not a feed. */
export function parseFeed(xml: string, url: string): FeedEntry[] {
  if (!/<feed[\s>]/i.test(xml)) {
    const head = xml.slice(0, 120).replace(/\s+/g, ' ');
    throw new RedditFeedError(
      `response from ${url} is not an Atom feed (starts: "${head}")`,
      'shape',
      url,
    );
  }

  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, raw]) => {
    const linkMatch = raw.match(/<link[^>]*href="([^"]+)"/);
    return {
      id: tag(raw, 'id'),
      title: decodeEntities(tag(raw, 'title')),
      author: tag(raw, 'name'),
      link: linkMatch ? decodeEntities(linkMatch[1]) : '',
      updated: tag(raw, 'updated'),
      contentHtml: tag(raw, 'content'),
    };
  });
}

/* ── Client ─────────────────────────────────────── */

export class RedditRssReader {
  private readonly subreddit: string;
  private readonly fetchImpl: FetchLike;
  private readonly feedAuth: { user: string; feed: string } | null;

  private readonly requestGapMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(opts: RedditRssOptions = {}) {
    this.subreddit = opts.subreddit ?? 'modular';
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.feedAuth = opts.feedAuth ?? null;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    // Account-scoped feed params restore the old rate, so pacing is only for the public path.
    this.requestGapMs = opts.requestGapMs ?? (this.feedAuth ? 0 : DEFAULT_REQUEST_GAP_MS);
  }

  /** Wait out the throttle before the next request. First request goes immediately. */
  private async pace(): Promise<void> {
    if (this.requestGapMs <= 0 || this.lastRequestAt === 0) return;
    const wait = this.lastRequestAt + this.requestGapMs - Date.now();
    if (wait > 0) await this.sleepImpl(wait);
  }

  private withAuth(url: string): string {
    if (!this.feedAuth) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}user=${encodeURIComponent(this.feedAuth.user)}&feed=${encodeURIComponent(this.feedAuth.feed)}`;
  }

  /**
   * One feed request. **Any non-200 throws** — 429 (throttled) and 403 (blocked) are the two we
   * expect to meet, and both would otherwise present as "the thread had no comments".
   */
  private async getFeed(url: string): Promise<FeedEntry[]> {
    await this.pace();
    this.lastRequestAt = Date.now();

    let res: Response;
    try {
      res = await this.fetchImpl(this.withAuth(url), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, text/xml' },
      });
    } catch (e) {
      throw new RedditFeedError(
        `could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`,
        'http',
        url,
      );
    }

    if (!res.ok) {
      const hint =
        res.status === 429
          ? ' — rate limited (Reddit allows roughly one request per minute per feed)'
          : res.status === 403
            ? ' — blocked; the feed or the User-Agent may no longer be accepted'
            : '';
      throw new RedditFeedError(`${url} returned HTTP ${res.status}${hint}`, 'http', url, res.status);
    }

    return parseFeed(await res.text(), url);
  }

  /**
   * The newest BST threads, newest first.
   *
   * **Returns several on purpose.** The caller scans more than one, which means we never have to
   * answer "which thread is the current one" — a question the API version answered by reading the
   * subreddit's sticky, and which RSS cannot answer at all because the feed carries no pinned
   * flag. Scanning the newest two also closes a real gap in the API design: for the days after a
   * new thread goes up, deals keep landing on the old one, and a single-thread scan missed them.
   */
  async findBstThreads(limit = 2): Promise<{ id: string; title: string; url: string }[]> {
    const url =
      `https://www.reddit.com/r/${this.subreddit}/search.rss` +
      `?q=${encodeURIComponent('title:"buy sell trade"')}&restrict_sr=1&sort=new&limit=10`;

    const entries = await this.getFeed(url);
    if (entries.length === 0) {
      throw new RedditFeedError(`search feed ${url} returned no entries at all`, 'empty', url);
    }

    const hits = entries
      .filter((e) => looksLikeBstThread(e.title))
      .map((e) => ({ id: e.id.replace(/^t3_/, ''), title: e.title, url: e.link }))
      .filter((t) => t.id && t.url);

    if (hits.length === 0) {
      throw new RedditFeedError(
        `no Buy/Sell/Trade thread among ${entries.length} search results in r/${this.subreddit} — ` +
          'the thread naming convention may have changed (see looksLikeBstThread)',
        'not-found',
        url,
      );
    }
    return hits.slice(0, limit);
  }

  /**
   * Every comment on a thread, as the matcher's own shape.
   *
   * No `more`-continuation problem here: the feed returns the whole thread in one response
   * (verified at 108 and 134 entries on full month-old threads, well under the `limit=500` asked
   * for). If that ever stops being true, `limit` is the knob — and a scan that comes back
   * suspiciously small is surfaced by the caller rather than reported as quiet.
   */
  async fetchComments(threadUrl: string): Promise<BstCommentInput[]> {
    const url = `${threadUrl.replace(/\/$/, '')}/.rss?limit=500&sort=old`;
    const entries = await this.getFeed(url);

    if (entries.length === 0) {
      throw new RedditFeedError(
        `thread feed ${url} parsed but contained no entries — the feed shape may have changed`,
        'empty',
        url,
      );
    }

    // `t1` is a comment; the submission itself comes back as a `t3` entry in the same feed.
    return entries
      .filter((e) => e.id.startsWith('t1_'))
      .map((e) => ({
        id: e.id.replace(/^t1_/, ''),
        author: e.author.replace(/^\/u\//, '') || '[unknown]',
        body: htmlToText(e.contentHtml),
        permalink: e.link,
      }))
      .filter((c) => c.id && c.body);
  }
}
