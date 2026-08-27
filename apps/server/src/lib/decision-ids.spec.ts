import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  HIGHEST_DECISION_AT_SEED,
  allocateDecisionId,
  bootstrapDecisionIdsSchema,
  formatDecisionId,
  peekNextDecisionId,
} from './decision-ids';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapDecisionIdsSchema(db);
});

describe('formatDecisionId', () => {
  it('zero-pads to three digits, matching the filenames in DECISIONS/', () => {
    expect(formatDecisionId(1)).toBe('D-001');
    expect(formatDecisionId(80)).toBe('D-080');
    expect(formatDecisionId(999)).toBe('D-999');
  });

  it('does not truncate past three digits', () => {
    // Better a four-digit id than a silently wrapped one. `parseDecisionFilename` would reject the
    // file, which is a loud failure — re-issuing D-000 would not be.
    expect(formatDecisionId(1000)).toBe('D-1000');
  });
});

describe('bootstrapDecisionIdsSchema', () => {
  it('is idempotent', () => {
    expect(() => bootstrapDecisionIdsSchema(db)).not.toThrow();
  });

  it('seeds so the first allocation is one past the highest existing decision', () => {
    expect(peekNextDecisionId(db)).toBe(formatDecisionId(HIGHEST_DECISION_AT_SEED + 1));
  });

  it('does not rewind the counter when it runs again on a later deploy', () => {
    // The failure this guards is the dangerous one: bootstrap runs on every process start, so a
    // re-seed would rewind to HIGHEST_DECISION_AT_SEED and re-issue every id allocated since.
    allocateDecisionId(db);
    allocateDecisionId(db);
    const before = peekNextDecisionId(db);

    bootstrapDecisionIdsSchema(db);

    expect(peekNextDecisionId(db)).toBe(before);
  });

  it('cannot be given a second counter row', () => {
    expect(() =>
      db.prepare('INSERT INTO decision_id_counter (id, last_num) VALUES (2, 500)').run(),
    ).toThrow();
  });
});

describe('allocateDecisionId', () => {
  it('hands out the next id', () => {
    expect(allocateDecisionId(db)).toBe(formatDecisionId(HIGHEST_DECISION_AT_SEED + 1));
    expect(allocateDecisionId(db)).toBe(formatDecisionId(HIGHEST_DECISION_AT_SEED + 2));
  });

  it('never returns the same id twice', () => {
    const ids = Array.from({ length: 200 }, () => allocateDecisionId(db));
    expect(new Set(ids).size).toBe(200);
  });

  it('is monotonic — it never back-fills a gap left by an abandoned decision', () => {
    // Gaps are expected and harmless: an id allocated for a PR that is never opened is simply
    // never used. Back-filling would reuse a number, which is the D-056 / D-065 failure.
    const ids = Array.from({ length: 10 }, () => Number(allocateDecisionId(db).slice(2)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('consumes the id even if the caller throws it away', () => {
    const taken = allocateDecisionId(db);
    expect(peekNextDecisionId(db)).not.toBe(taken);
  });

  it('throws rather than seeding a counter it cannot know is free', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE decision_id_counter (id INTEGER PRIMARY KEY, last_num INTEGER NOT NULL)');
    expect(() => allocateDecisionId(bare)).toThrow(/never run/);
  });
});

describe('peekNextDecisionId', () => {
  it('does not consume the id it reports', () => {
    const peeked = peekNextDecisionId(db);
    expect(peekNextDecisionId(db)).toBe(peeked);
    expect(allocateDecisionId(db)).toBe(peeked);
  });
});

/**
 * The guard that keeps {@link HIGHEST_DECISION_AT_SEED} honest.
 *
 * The constant exists because the production image has no `DECISIONS/` to scan (`docker/Dockerfile`
 * copies only `dist`, `build` and `node_modules`), so the derivation the ticket asks for happens
 * here, in CI, against the real directory. If a decision lands with a higher number than the seed
 * claims — by hand, or by the numbering cycle before the PD-560 cutover retires it — this goes red
 * on the next run rather than the counter silently re-issuing a live id.
 */
describe('HIGHEST_DECISION_AT_SEED', () => {
  function repoRoot(): string {
    let dir = path.resolve(process.cwd());
    for (;;) {
      if (existsSync(path.join(dir, 'DECISIONS')) && existsSync(path.join(dir, 'DECISIONS.md'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`no repo root above ${process.cwd()}`);
      dir = parent;
    }
  }

  it('is at least the highest D-NNN in DECISIONS/', () => {
    const dir = path.join(repoRoot(), 'DECISIONS');
    const highest = readdirSync(dir)
      .map((f) => /^D-(\d{3})-[a-z0-9][a-z0-9-]*\.md$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .reduce((max, m) => Math.max(max, Number(m[1])), 0);

    expect(highest).toBeGreaterThan(0); // the scan itself works — an empty result must not pass

    // If this fails, set HIGHEST_DECISION_AT_SEED to `highest` in decision-ids.ts. Do not lower it:
    // the counter has already handed out ids above the old value in production.
    expect(HIGHEST_DECISION_AT_SEED).toBeGreaterThanOrEqual(highest);
  });
});
