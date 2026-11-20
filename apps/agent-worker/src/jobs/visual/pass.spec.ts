import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config';
import { ensureRunsTable, finishRun, startRun } from '../robot/runs';
import { ensureRobotStateTable } from '../robot/state';
import type { CaptureOutcome } from './capture';
import { captureComment, runVisualPass, type PrView } from './pass';

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
    db.prepare("INSERT INTO agent_tickets (id, status, assignee, agent_state) VALUES (1, 'queue', 'robot', 'in-review')").run();
    const runId = startRun(db, { ticketId: 1, issueNumber: null, branch: 'robot/t1' }, 10);
    finishRun(db, runId, { status: 'handed-off', prUrl: 'https://github.com/scolacur/personal-dashboard/pull/314' }, 100);
  });

  const view = (files: string[], body = ''): (() => Promise<PrView>) => async () => ({ headRefOid: SHA, body, files: files.map((path) => ({ path })) });

  it('captures a web PR once per head, logs thumbnails on the ticket, and comments links', async () => {
    const targets: { routes: string[] }[] = [];
    const comments: string[] = [];
    const deps = {
      viewPr: view(['apps/web/src/routes/habits/+page.svelte']),
      capture: async (t: { routes: string[] }) => (targets.push(t), captured),
      comment: async (_r: string, _n: number, b: string) => void comments.push(b),
    };
    expect(await runVisualPass(db, cfg(), 1000, deps)).toBe('captured');
    expect(targets[0].routes).toEqual(['/habits']);
    const ev = db.prepare("SELECT detail FROM agent_ticket_events WHERE type = 'robot_visual_captured'").get() as { detail: string };
    expect(JSON.parse(ev.detail).shots[0].url).toBe('/api/visual-captures/pr-314/abc1234/habits-desktop-light.png');
    expect(comments[0]).toContain('[view](http://nas:8088/api/visual-captures/pr-314/abc1234/habits-desktop-light.png)');
    expect(await runVisualPass(db, cfg(), 2000, deps)).toBeNull(); // same head: done
  });

  it('skips a PR with no web changes without building anything', async () => {
    let built = false;
    const out = await runVisualPass(db, cfg(), 1000, { viewPr: view(['apps/server/src/x.ts']), capture: async () => ((built = true), captured) });
    expect(out).toBeNull();
    expect(built).toBe(false);
  });

  it('is inert when disabled', async () => {
    expect(await runVisualPass(db, cfg({ VISUAL_CAPTURE_ENABLED: '0' }), 1000, { viewPr: view(['apps/web/src/a.ts']) })).toBeNull();
  });

  it('comments without links when no public URL is set', () => {
    expect(captureComment('', 314, SHA, captured as Extract<CaptureOutcome, { kind: 'captured' }>)).toMatch(/ticket timeline/);
  });
});
