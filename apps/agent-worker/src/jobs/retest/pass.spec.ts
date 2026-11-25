import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config';
import { ensureRobotStateTable } from '../robot/state';
import { redWindows, runRetestPass, type MainCiRun, type RetestPr, type ToggleOutcome } from './pass';

const cfg = (env: Record<string, string> = {}) =>
  loadConfig({ ROBOT_GITHUB_TOKEN: 'tok', RETEST_INTERVAL_MS: '0', ...env });

const main = (conclusion: string, createdAt: string, updatedAt = createdAt, status = 'completed'): MainCiRun => ({
  status,
  conclusion,
  createdAt,
  updatedAt,
});

// main: green at 01:00, red from 02:00 (failed) until the 03:00 run, which went green at 03:10.
const redThenGreen = [
  main('success', '2026-11-23T03:00:00Z', '2026-11-23T03:10:00Z'),
  main('failure', '2026-11-23T02:30:00Z', '2026-11-23T02:40:00Z'),
  main('failure', '2026-11-23T02:00:00Z', '2026-11-23T02:10:00Z'),
  main('success', '2026-11-23T01:00:00Z', '2026-11-23T01:10:00Z'),
];

const pr = (over: Partial<RetestPr> = {}, verify: { conclusion?: string; status?: string; startedAt?: string } = {}): RetestPr => ({
  number: 527,
  headRefName: 'memory-wrap-up',
  headRefOid: 'aaa',
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  url: 'https://github.com/scolacur/personal-dashboard/pull/527',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-23T02:45:00Z', ...verify },
  ],
  ...over,
});

describe('redWindows (PD-942)', () => {
  it('is null while main is red', () => {
    expect(redWindows([main('failure', '2026-11-23T04:00:00Z'), ...redThenGreen])).toBeNull();
  });

  it('spans the first failure of a streak to the completion of the success that ended it', () => {
    expect(redWindows(redThenGreen)).toEqual([
      { start: Date.parse('2026-11-23T02:00:00Z'), end: Date.parse('2026-11-23T03:10:00Z') },
    ]);
  });

  it('ignores cancelled and in-progress runs', () => {
    const runs = [main('', '2026-11-23T05:00:00Z', '2026-11-23T05:00:00Z', 'in_progress'), main('cancelled', '2026-11-23T04:00:00Z'), ...redThenGreen];
    expect(redWindows(runs)).toHaveLength(1);
  });

  it('keeps every red window in the history, so a missed short green still counts', () => {
    const runs = [
      main('success', '2026-11-23T06:00:00Z', '2026-11-23T06:10:00Z'),
      main('failure', '2026-11-23T05:00:00Z'),
      ...redThenGreen,
    ];
    expect(redWindows(runs)).toHaveLength(2);
  });
});

describe('runRetestPass (PD-942)', () => {
  let db: Database.Database;
  let toggled: number[];
  const toggleWith = (outcome: ToggleOutcome) => async (_repo: string, n: number) => {
    toggled.push(n);
    return outcome;
  };
  const retested: ToggleOutcome = { kind: 'retested' };

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE TABLE agent_notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ticket_id INTEGER, title TEXT NOT NULL, body TEXT, read_at INTEGER, created_at INTEGER NOT NULL);',
    );
    ensureRobotStateTable(db);
    toggled = [];
  });

  const pass = (prs: RetestPr[], runs: MainCiRun[] = redThenGreen, outcome: ToggleOutcome = retested, config = cfg()) =>
    runRetestPass(db, config, 5000, { listMainRuns: async () => runs, listOpenPrs: async () => prs, toggle: toggleWith(outcome) });

  it('is inert when disabled or without a write token', async () => {
    expect(await pass([pr()], redThenGreen, retested, cfg({ RETEST_ENABLED: '0' }))).toBeNull();
    expect(await pass([pr()], redThenGreen, retested, loadConfig({ RETEST_INTERVAL_MS: '0' }))).toBeNull();
    expect(toggled).toEqual([]);
  });

  it('re-tests a PR whose verify failed while main was red', async () => {
    expect(await pass([pr()])).toEqual([527]);
    expect(toggled).toEqual([527]);
  });

  it('does nothing while main is still red', async () => {
    expect(await pass([pr()], [main('failure', '2026-11-23T04:00:00Z'), ...redThenGreen])).toEqual([]);
    expect(toggled).toEqual([]);
  });

  it('leaves a PR that failed after main went green: it failed for its own reasons', async () => {
    await pass([pr({}, { startedAt: '2026-11-23T03:20:00Z' })]);
    expect(toggled).toEqual([]);
  });

  it('leaves a PR that failed before main went red', async () => {
    await pass([pr({}, { startedAt: '2026-11-23T01:30:00Z' })]);
    expect(toggled).toEqual([]);
  });

  it('leaves drafts, forks, PRs not into main, and PRs whose latest verify passed or is running', async () => {
    await pass([
      pr({ number: 1, isDraft: true }),
      pr({ number: 2, isCrossRepository: true }),
      pr({ number: 3, baseRefName: 'other' }),
      pr({ number: 4 }, { conclusion: 'SUCCESS' }),
      pr({ number: 5 }, { status: 'IN_PROGRESS', conclusion: '' }),
      pr({ number: 6, statusCheckRollup: null }),
    ]);
    expect(toggled).toEqual([]);
  });

  it('judges the LATEST verify run: a fresh pass after an earlier failure is left alone', async () => {
    const both = pr({
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-23T02:45:00Z' },
        { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-23T03:30:00Z' },
      ],
    });
    await pass([both]);
    expect(toggled).toEqual([]);
  });

  it('retries a PR at most once per head SHA, and again after a new push', async () => {
    await pass([pr()]);
    await pass([pr()]); // failed again on fresh main (or not re-run yet): stays red
    expect(toggled).toEqual([527]);
    await pass([pr({ headRefOid: 'bbb' })]);
    expect(toggled).toEqual([527, 527]);
  });

  it('tries a toggle that changed nothing again, up to three times per head', async () => {
    for (let i = 0; i < 5; i++) await pass([pr()], redThenGreen, { kind: 'error', reason: 'network' });
    expect(toggled).toEqual([527, 527, 527]);
  });

  it('notifies Steve when a PR is left as a draft, and does not touch it again', async () => {
    await pass([pr()], redThenGreen, { kind: 'stuck-draft', reason: 'mark ready failed' });
    await pass([pr()]);
    expect(toggled).toEqual([527]);
    const notes = db.prepare('SELECT kind, title FROM agent_notifications').all() as { kind: string; title: string }[];
    expect(notes).toEqual([{ kind: 'agent_needs_human', title: 'PR #527 was left as a draft' }]);
  });
});
