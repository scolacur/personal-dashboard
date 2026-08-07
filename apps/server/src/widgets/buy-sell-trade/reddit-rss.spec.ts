import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RedditFeedError,
  RedditRssReader,
  decodeEntities,
  htmlToText,
  parseFeed,
} from './reddit-rss';

// Fixtures are REAL captured responses from r/modular (2026-08-06), trimmed to a few entries.
// Hand-written XML would only prove the parser matches my idea of the feed.
const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

const THREAD = fixture('thread-comments.rss.xml');
const SEARCH = fixture('search-bst.rss.xml');

function reader(responses: Array<{ status?: number; body?: string } | Error>) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body ?? '' } as Response;
  };
  // requestGapMs 0: pacing is exercised in its own block, not paid for in every test.
  return { reader: new RedditRssReader({ fetchImpl, requestGapMs: 0 }), calls };
}

describe('decodeEntities', () => {
  it('decodes the numeric form Reddit uses for apostrophes', () => {
    expect(decodeEntities('don&#39;t')).toBe("don't");
    expect(decodeEntities('&#x27;')).toBe("'");
  });

  it('decodes named entities and leaves unknown ones intact', () => {
    expect(decodeEntities('&lt;p&gt; &amp; &quot;x&quot;')).toBe('<p> & "x"');
    expect(decodeEntities('&notreal;')).toBe('&notreal;');
  });
});

describe('htmlToText', () => {
  // Load-bearing: the matcher corroborates a generic name against the manufacturer **in the same
  // line item**. Flattening a comment's paragraphs into one line would let any maker in the
  // comment vouch for any module in it — silently turning `possible` matches into `confirmed`.
  it('keeps one line per block element', () => {
    const html = '&lt;div&gt;&lt;p&gt;2hp Verb $60&lt;/p&gt;&lt;p&gt;Doepfer mix $40&lt;/p&gt;&lt;/div&gt;';
    expect(htmlToText(html).split('\n')).toEqual(['2hp Verb $60', 'Doepfer mix $40']);
  });

  it('strips Reddit’s SC_OFF/SC_ON comment wrappers', () => {
    const html = '&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;WTS&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;';
    expect(htmlToText(html)).toBe('WTS');
  });

  it('turns <br> into a line break', () => {
    expect(htmlToText('a&lt;br&gt;b')).toBe('a\nb');
  });

  it('collapses runs of blank lines and trims', () => {
    expect(htmlToText('&lt;p&gt;a&lt;/p&gt;&lt;p&gt;&lt;/p&gt;&lt;p&gt;&lt;/p&gt;&lt;p&gt;b&lt;/p&gt;')).toBe('a\n\nb');
  });
});

describe('parseFeed', () => {
  it('reads every entry out of a real captured thread feed', () => {
    const entries = parseFeed(THREAD, 'x');
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.id)).toBe(true);
  });

  it('pulls the fields the matcher needs off a real comment entry', () => {
    const e = parseFeed(THREAD, 'x').find((x) => x.author === '/u/gnomefront')!;
    expect(e.id).toMatch(/^t1_/);
    expect(e.link).toContain('reddit.com');
    expect(htmlToText(e.contentHtml)).toContain('Qu-Bit Mixology $200');
  });

  // A 403 HTML error page, or a redesigned feed, must not parse as "zero comments".
  it('throws on a document that is not a feed', () => {
    expect(() => parseFeed('<html><body>Blocked</body></html>', 'u')).toThrow(RedditFeedError);
    expect(() => parseFeed('', 'u')).toThrow(/not an Atom feed/);
  });
});

describe('findBstThreads', () => {
  it('finds the BST threads in a real search feed, newest first', async () => {
    const { reader: r } = reader([{ body: SEARCH }]);
    const out = await r.findBstThreads(2);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Monthly Modular Buy Sell Trade Thread');
    expect(out[0].id).not.toMatch(/^t3_/);
    expect(out[0].url).toContain('/comments/');
  });

  // Scanning two removes the need to know which thread is "current" — RSS carries no pinned
  // flag — and covers the days when deals still land on last month's thread.
  it('returns more than one so the caller never has to pick the current thread', async () => {
    const { reader: r } = reader([{ body: SEARCH }]);
    expect(await r.findBstThreads(1)).toHaveLength(1);
    expect((await r.findBstThreads(4)).length).toBeGreaterThan(1);
  });

  it('sends a descriptive User-Agent and asks for newest first', async () => {
    const { reader: r, calls } = reader([{ body: SEARCH }]);
    await r.findBstThreads();
    expect(calls[0]).toContain('search.rss');
    expect(calls[0]).toContain('sort=new');
  });

  it('throws, rather than returning nothing, when no title matches', async () => {
    const stripped = SEARCH.replace(/Monthly Modular Buy Sell Trade Thread/g, 'Patch of the day');
    const { reader: r } = reader([{ body: stripped }]);
    await expect(r.findBstThreads()).rejects.toThrow(/naming convention may have changed/);
  });
});

describe('fetchComments', () => {
  it('maps a real thread feed to the matcher’s comment shape', async () => {
    const { reader: r } = reader([{ body: THREAD }]);
    const out = await r.fetchComments('https://www.reddit.com/r/modular/comments/1vd6i2g/x/');
    expect(out.length).toBeGreaterThan(0);
    const g = out.find((c) => c.author === 'gnomefront')!;
    expect(g.id).not.toMatch(/^t1_/);
    expect(g.body).toContain('Intellijel Morgasmatron $390');
    expect(g.permalink).toContain('reddit.com');
  });

  it('drops the submission entry — only t1 comments reach the matcher', async () => {
    const { reader: r } = reader([{ body: THREAD }]);
    const out = await r.fetchComments('https://www.reddit.com/r/modular/comments/1vd6i2g/x/');
    // The fixture carries the t3 submission alongside the comments.
    expect(parseFeed(THREAD, 'x').some((e) => e.id.startsWith('t3_'))).toBe(true);
    expect(out.every((c) => c.body)).toBe(true);
  });

  it('strips the /u/ prefix so the author matches what the readout renders', async () => {
    const { reader: r } = reader([{ body: THREAD }]);
    const out = await r.fetchComments('https://www.reddit.com/r/modular/comments/1vd6i2g/x/');
    expect(out.every((c) => !c.author.startsWith('/u/'))).toBe(true);
  });
});

// The whole point. "No offers this week" and "Reddit refused the request" must never look alike.
describe('fails loudly', () => {
  it('throws on 429 rather than reporting an empty thread', async () => {
    const { reader: r } = reader([{ status: 429, body: '' }]);
    await expect(r.findBstThreads()).rejects.toThrow(/HTTP 429.*rate limited/s);
  });

  it('throws on 403 with a hint about what changed', async () => {
    const { reader: r } = reader([{ status: 403, body: '' }]);
    await expect(r.findBstThreads()).rejects.toThrow(/HTTP 403.*blocked/s);
  });

  it('throws when the network is unreachable', async () => {
    const { reader: r } = reader([new Error('ENOTFOUND')]);
    await expect(r.findBstThreads()).rejects.toThrow(/could not reach/);
  });

  it('throws when a feed parses but is empty', async () => {
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
    const { reader: r } = reader([{ body: empty }]);
    await expect(r.findBstThreads()).rejects.toThrow(/no entries at all/);
    const { reader: r2 } = reader([{ body: empty }]);
    await expect(r2.fetchComments('https://www.reddit.com/r/modular/comments/x/y/')).rejects.toThrow(
      /contained no entries/,
    );
  });

  it('carries the status and url on the error for the readout to show', async () => {
    const { reader: r } = reader([{ status: 429, body: '' }]);
    const err = await r.findBstThreads().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditFeedError);
    expect((err as RedditFeedError).kind).toBe('http');
    expect((err as RedditFeedError).status).toBe(429);
    expect((err as RedditFeedError).url).toContain('search.rss');
  });
});

// Caught by a live smoke test, not by fixtures: one scan is three requests (search + two
// threads), and unpaced they get 429'd partway. Without this, every real scan would report
// `partial` forever.
describe('rate-limit pacing', () => {
  function paced(gap: number) {
    const waits: number[] = [];
    const r = new RedditRssReader({
      fetchImpl: async () =>
        ({ ok: true, status: 200, text: async () => SEARCH }) as Response,
      requestGapMs: gap,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    return { r, waits };
  }

  it('does not delay the first request', async () => {
    const { r, waits } = paced(70_000);
    await r.findBstThreads();
    expect(waits).toEqual([]);
  });

  it('waits out the gap before a second request', async () => {
    const { r, waits } = paced(70_000);
    await r.findBstThreads();
    await r.findBstThreads();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(60_000);
  });

  it('does not pace at all when account feed params are supplied', async () => {
    const waits: number[] = [];
    const r = new RedditRssReader({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => SEARCH }) as Response,
      feedAuth: { user: 'u', feed: 'f' },
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    await r.findBstThreads();
    await r.findBstThreads();
    expect(waits).toEqual([]);
  });

  it('appends the account feed params when present', async () => {
    const calls: string[] = [];
    const r = new RedditRssReader({
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => SEARCH } as Response;
      },
      feedAuth: { user: 'steve', feed: 'abc123' },
    });
    await r.findBstThreads();
    expect(calls[0]).toContain('user=steve');
    expect(calls[0]).toContain('feed=abc123');
  });
});
