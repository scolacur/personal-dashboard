import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config';
import { ensureRunsTable, finishRun, startRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import type { CaptureOutcome } from './capture';
import { captureComment, ensureVisualCapturesTable, runVisualPass, ticketLabel, type PrView } from './pass';
import type { CaptureTarget } from './routes';
import { recordCapture, recordCaptureHeartbeat } from './status';

const SHA = 'abc1234def';
const cfg = (over: Record<string, string> = {}) =>
  loadConfig({ VISUAL_CAPTURE_ENABLED: '1', VISUAL_CAPTURE_INTERVAL_MS: '0', ROBOT_GITHUB_TOKEN: 'w', DASHBOARD_PUBLIC_URL: 'http://nas:8088/', ...over });

const captured: CaptureOutcome = {
  kind: 'captured',
  dir: '/data/visual-captures/pr-314/abc1234',
  manifest: {
    prNumber: 314,
    headSha: SHA,
    routes: ['/habits'],
    shots: [
      { route: '/habits', viewport: 'desktop', scheme: 'light', file: 'habits-desktop-light.png' },
      { route: '/habits', viewport: 'phone', scheme: 'dark', file: 'habits-phone-dark.png' },
    ],
    createdAt: 1,
  },
};

describe('runVisualPass (PD-773)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    ensureVisualCapturesTable(db);
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, assignee, agent_state) VALUES (1, 'PD-846', 'Habit grid', 'queue', 'robot', 'in-review')").run();
    const runId = startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/t1' }, 10);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
  });

  const view = (files: string[], body = ''): (() => Promise<PrView>) => async () => ({ headRefOid: SHA, body, files: files.map((path) => ({ path })) });

  it('captures a web PR once per head, logs thumbnails on the ticket, and comments links', async () => {
    const targets: { targets: CaptureTarget[] }[] = [];
    const comments: string[] = [];
    const deps = {
      listPrs: async () => [], viewPr: view(['apps/web/src/routes/habits/+page.svelte']),
      capture: async (t: { targets: CaptureTarget[] }) => (targets.push(t), captured),
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    };
    expect(await runVisualPass(db, cfg(), 1000, deps)).toBe('captured');
    expect(targets[0].targets).toEqual([{ route: '/habits', steps: [] }]);
    const ev = db.prepare("SELECT detail FROM agent_ticket_events WHERE type = 'robot_visual_captured'").get() as { detail: string };
    expect(JSON.parse(ev.detail).shots[0].url).toBe('/api/visual-captures/pr-314/abc1234/habits-desktop-light.png');
    expect(comments[0]).toContain('[view](http://nas:8088/api/visual-captures/pr-314/abc1234/habits-desktop-light.png)');
    expect(comments[0]).toMatch(/Visual: captured 2 screenshots/);
    // PD-846: the comment names the PR's OWN ticket, not the tickets that built the capture tool.
    expect(comments[0]).toContain('PD-846 (Habit grid)');
    expect(comments[0]).not.toContain('PD-773');
    expect(comments[0]).not.toContain('PD-798');
    expect(await runVisualPass(db, cfg(), 2000, deps)).toBeNull(); // same head: done
  });

  it('skips a PR with no web changes without building anything, and says so on the PR once', async () => {
    let built = false;
    const comments: string[] = [];
    const deps = {
      listPrs: async () => [], viewPr: view(['apps/server/src/x.ts']),
      capture: async () => ((built = true), captured),
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    };
    expect(await runVisualPass(db, cfg(), 1000, deps)).toBeNull();
    expect(built).toBe(false);
    expect(comments).toEqual([expect.stringMatching(/Visual: no UI change/)]);
    await runVisualPass(db, cfg(), 2000, deps);
    expect(comments).toHaveLength(1);
  });

  it('says on the PR when capture failed, with the reason (PD-793)', async () => {
    const comments: string[] = [];
    const out = await runVisualPass(db, cfg(), 1000, {
      listPrs: async () => [], viewPr: view(['apps/web/src/a.ts']),
      capture: async () => ({ kind: 'failed', reason: 'vite build exited 1' }) as CaptureOutcome,
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    });
    expect(out).toBe('failed');
    expect(comments[0]).toMatch(/Visual: capture failed/);
    expect(comments[0]).toContain('vite build exited 1');
  });

  it('still photographs a head recorded while capture was off, once capture is on', async () => {
    recordCapture(db, { ticketId: 1, prNumber: 314, headSha: SHA, outcome: 'off', detail: 'unset' }, 500);
    const out = await runVisualPass(db, cfg(), 1000, {
      listPrs: async () => [], viewPr: view(['apps/web/src/a.ts']),
      capture: async () => captured,
      comment: async () => {},
    });
    expect(out).toBe('captured');
  });

  it('records the capture heartbeat, on or off (PD-794)', () => {
    recordCaptureHeartbeat(db, cfg(), 1000);
    expect(db.prepare("SELECT value, updated_at FROM robot_state WHERE key = 'visual_capture_enabled'").get()).toEqual({ value: '1', updated_at: 1000 });
    recordCaptureHeartbeat(db, cfg({ VISUAL_CAPTURE_ENABLED: '0' }), 2000);
    expect(db.prepare("SELECT value, updated_at FROM robot_state WHERE key = 'visual_capture_enabled'").get()).toEqual({ value: '0', updated_at: 2000 });
  });

  it('is inert when disabled', async () => {
    expect(await runVisualPass(db, cfg({ VISUAL_CAPTURE_ENABLED: '0' }), 1000, { listPrs: async () => [], viewPr: view(['apps/web/src/a.ts']) })).toBeNull();
  });

  it('comments without links when no public URL is set', () => {
    expect(captureComment('', 314, SHA, captured as Extract<CaptureOutcome, { kind: 'captured' }>, 'PD-846 (Habit grid)')).toMatch(/ticket timeline/);
  });

  it('labels the capture line with the PR ticket passed in, never a hardcoded build-citation (PD-846)', () => {
    const c = captureComment('', 314, SHA, captured as Extract<CaptureOutcome, { kind: 'captured' }>, 'PD-846 (Habit grid)');
    expect(c).toContain('for PD-846 (Habit grid), built from this PR');
    expect(c).not.toContain('PD-773');
    expect(c).not.toContain('PD-798');
  });

  it('ticketLabel resolves the PR ticket, falling back to #id when display_id is null (PD-846)', () => {
    expect(ticketLabel(db, 1)).toBe('PD-846 (Habit grid)');
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status) VALUES (2, NULL, 'No display id', 'queue')").run();
    expect(ticketLabel(db, 2)).toBe('#2 (No display id)');
    expect(ticketLabel(db, 999)).toBe('#999'); // no row
  });
  it('passes the Visual: line\'s click steps to the capture and records step failures on the ticket (PD-798)', async () => {
    const seen: { targets: CaptureTarget[] }[] = [];
    const withSteps: CaptureOutcome = {
      ...captured,
      manifest: {
        ...captured.manifest,
        routes: ['/widgets/habit-tracker'],
        shots: [
          { route: '/widgets/habit-tracker', viewport: 'desktop', scheme: 'light', file: 'a.png' },
          { route: '/widgets/habit-tracker', viewport: 'desktop', scheme: 'light', file: 'b.png', step: 'click "Habits"', stepIndex: 1 },
        ],
        failures: [{ route: '/widgets/habit-tracker', step: 'click "Add metric"', reason: 'nothing on the page is named "Add metric"' }],
      },
    };
    const comments: string[] = [];
    await runVisualPass(db, cfg(), 1000, {
      listPrs: async () => [], viewPr: view(['apps/web/src/routes/widgets/habit-tracker/TodayList.svelte'], 'Visual: /widgets/habit-tracker > click "Habits" > click "Add metric"'),
      capture: async (t: { targets: CaptureTarget[] }) => (seen.push(t), withSteps),
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    });
    expect(seen[0].targets).toEqual([
      { route: '/widgets/habit-tracker', steps: [{ kind: 'click', label: 'Habits' }, { kind: 'click', label: 'Add metric' }] },
    ]);
    const ev = db.prepare("SELECT detail FROM agent_ticket_events WHERE type = 'robot_visual_captured'").get() as { detail: string };
    expect(JSON.parse(ev.detail).failures).toHaveLength(1);
    expect(comments[0]).toContain('`/widgets/habit-tracker` › click "Habits"');
    expect(comments[0]).toContain('**1 step could not run:**');
  });
});

describe('runVisualPass on session PRs (PD-915)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, display_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, assignee TEXT, agent_state TEXT, archived_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE agent_ticket_events (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
    `);
    ensureRunsTable(db);
    ensureRobotStateTable(db);
    ensureVisualCapturesTable(db);
    db.prepare("INSERT INTO agent_tickets (id, display_id, title, status, assignee) VALUES (705, 'PD-705', 'Do the thing', 'queue', 'steve')").run();
  });

  const sessionPr = (over: Record<string, unknown> = {}) => ({
    number: 500, title: 't', body: '', headRefName: 'pd-705-thing', headRefOid: SHA, baseRefName: 'main',
    isCrossRepository: false, isDraft: false, labels: [], files: [{ path: 'apps/web/src/routes/habits/+page.svelte' }], ...over,
  });

  it('captures a session PR after the Robot targets, onto its branch ticket, once per head', async () => {
    const comments: string[] = [];
    const deps = {
      listPrs: async () => [sessionPr()],
      viewPr: async () => null,
      capture: async () => captured,
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    };
    expect(await runVisualPass(db, cfg(), 1000, deps)).toBe('captured');
    const ev = db.prepare("SELECT ticket_id AS t FROM agent_ticket_events WHERE type = 'robot_visual_captured'").get();
    expect(ev).toEqual({ t: 705 });
    expect(comments[0]).toContain('for PD-705 (Do the thing)');
    expect(await runVisualPass(db, cfg(), 2000, deps)).toBeNull();
  });

  it('captures a session PR with no branch ticket on the PR only, and skips drafts', async () => {
    const comments: string[] = [];
    const base = { viewPr: async () => null, capture: async () => captured, comment: async (_r: string, _n: number, b: string) => void comments.push(b) };
    expect(await runVisualPass(db, cfg(), 1000, { ...base, listPrs: async () => [sessionPr({ isDraft: true })] })).toBeNull();
    expect(await runVisualPass(db, cfg(), 2000, { ...base, listPrs: async () => [sessionPr({ headRefName: 'misc' })] })).toBe('captured');
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_ticket_events WHERE type = 'robot_visual_captured'").get()).toEqual({ n: 0 });
    expect(comments[0]).toContain('PR #500 (no linked ticket)');
  });
});
