import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { RATE_LIMIT_STALE_MS, rateLimitHealth, type GithubRateLimitStatus } from '@dashboard/shared';
import { RATE_LIMIT_STATE_KEY, parseRateLimitProbe, recordRateLimit } from './rate-limit';
import { ensureRobotStateTable } from './state';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const RESET_SEC = Math.floor(NOW / 1000) + 1800;

/** A realistic `gh api rate_limit` payload. */
function payload(over: { coreRemaining?: number; graphql?: boolean } = {}): string {
  const core = { limit: 5000, used: 100, remaining: over.coreRemaining ?? 4900, reset: RESET_SEC };
  return JSON.stringify({
    resources: {
      core,
      ...(over.graphql === false ? {} : { graphql: { limit: 5000, used: 0, remaining: 5000, reset: RESET_SEC } }),
      search: { limit: 30, used: 0, remaining: 30, reset: RESET_SEC },
    },
    rate: core,
  });
}

describe('parseRateLimitProbe', () => {
  it('reads core and graphql, converting the epoch from seconds to ms', () => {
    const s = parseRateLimitProbe(payload(), NOW);
    expect(s).toEqual({
      core: { remaining: 4900, limit: 5000, resetAt: RESET_SEC * 1000 },
      graphql: { remaining: 5000, limit: 5000, resetAt: RESET_SEC * 1000 },
      checkedAt: NOW,
    });
  });

  it('accepts a payload with no graphql bucket — not every token reports one', () => {
    expect(parseRateLimitProbe(payload({ graphql: false }), NOW)?.graphql).toBeNull();
  });

  it('falls back to the legacy top-level `rate` when `resources` is absent', () => {
    const legacy = JSON.stringify({ rate: { limit: 60, used: 10, remaining: 50, reset: RESET_SEC } });
    expect(parseRateLimitProbe(legacy, NOW)?.core).toEqual({ remaining: 50, limit: 60, resetAt: RESET_SEC * 1000 });
  });

  // This is a dashboard reading inside the worker's interval. A shape change from GitHub must
  // degrade to "no data", never throw.
  it.each([
    ['not json at all', 'not json at all'],
    ['a payload with no core bucket', JSON.stringify({ resources: { search: {} } })],
    ['non-numeric fields', JSON.stringify({ resources: { core: { limit: 'lots', remaining: null, reset: 'soon' } } })],
    ['an empty string', ''],
  ])('returns null for %s', (_label, raw) => {
    expect(parseRateLimitProbe(raw, NOW)).toBeNull();
  });
});

describe('recordRateLimit', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureRobotStateTable(db);
  });

  function stored(): GithubRateLimitStatus | null {
    const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(RATE_LIMIT_STATE_KEY) as
      | { value: string | null }
      | undefined;
    return row?.value ? (JSON.parse(row.value) as GithubRateLimitStatus) : null;
  }

  it('stores a good probe', async () => {
    await recordRateLimit(db, async () => payload(), NOW);
    expect(stored()?.core.remaining).toBe(4900);
  });

  // The failure posture that matters: a failed probe leaves the LAST reading in place, so its
  // `checkedAt` ages into "stale" on its own. Clearing it would read as "never probed", which is a
  // different condition needing a different response.
  it('leaves the previous reading in place when the probe throws', async () => {
    await recordRateLimit(db, async () => payload(), NOW);
    await recordRateLimit(db, async () => {
      throw new Error('gh: command not found');
    }, NOW + 60_000);
    expect(stored()?.checkedAt).toBe(NOW);
  });

  it('leaves the previous reading in place when the payload is unrecognised', async () => {
    await recordRateLimit(db, async () => payload(), NOW);
    await recordRateLimit(db, async () => '<html>502 Bad Gateway</html>', NOW + 60_000);
    expect(stored()?.checkedAt).toBe(NOW);
  });

  it('never throws, whatever the probe does', async () => {
    await expect(
      recordRateLimit(db, async () => {
        throw new Error('boom');
      }, NOW),
    ).resolves.toBeNull();
  });
});

describe('rateLimitHealth', () => {
  const fresh = (core: { remaining: number; limit: number }): GithubRateLimitStatus => ({
    core: { ...core, resetAt: RESET_SEC * 1000 },
    graphql: null,
    checkedAt: NOW,
  });

  it('is ok with headroom, low near the floor, exhausted at zero', () => {
    expect(rateLimitHealth(fresh({ remaining: 4900, limit: 5000 }), NOW)).toBe('ok');
    expect(rateLimitHealth(fresh({ remaining: 400, limit: 5000 }), NOW)).toBe('low');
    expect(rateLimitHealth(fresh({ remaining: 0, limit: 5000 }), NOW)).toBe('exhausted');
  });

  it('reports the WORST bucket — headroom in one quota is no comfort when the other is spent', () => {
    const s: GithubRateLimitStatus = {
      core: { remaining: 5000, limit: 5000, resetAt: RESET_SEC * 1000 },
      graphql: { remaining: 0, limit: 5000, resetAt: RESET_SEC * 1000 },
      checkedAt: NOW,
    };
    expect(rateLimitHealth(s, NOW)).toBe('exhausted');
  });

  // Staleness outranks the numbers: if the probe stopped running, a comfortable reading from an
  // hour ago says nothing about now, and showing it as healthy is worse than showing nothing.
  it('reports stale over a healthy-looking but old reading', () => {
    const s = fresh({ remaining: 5000, limit: 5000 });
    expect(rateLimitHealth(s, NOW + RATE_LIMIT_STALE_MS + 1)).toBe('stale');
    expect(rateLimitHealth(s, NOW + RATE_LIMIT_STALE_MS - 1)).toBe('ok');
  });

  it('reports stale when there has never been a probe', () => {
    expect(rateLimitHealth(null, NOW)).toBe('stale');
  });
});
