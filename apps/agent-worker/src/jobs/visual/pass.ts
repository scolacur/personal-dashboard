import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { logMilestone } from '../robot/events';
import { inReviewPrTargets } from '../robot/pr-state';
import { readStateNumber, writeState } from '../robot/state';
import { captureVisuals, type CaptureDeps, type CaptureOutcome } from './capture';
import { captureRoutes, touchesWeb } from './routes';
import { captureFailedComment, ensureVisualCapturesTable, headSettled, noUiChangeComment, recordCapture, type Commenter } from './status';

export { ensureVisualCapturesTable };

const run = promisify(execFile);

/**
 * The visual-capture poll (PD-773). Each pass takes ONE in-review Robot PR whose diff touches the web
 * app and has no capture at its current head, photographs it, and links the result from the PR and
 * the ticket timeline. One per pass, because a capture is a full build plus a browser.
 *
 * Every head it settles gets one PR comment (PD-793): the screenshots, the failure, or "no UI change".
 */

export interface PrView {
  headRefOid: string;
  body: string;
  files: { path: string }[];
}
export type PrViewer = (repo: string, prNumber: number) => Promise<PrView | null>;
export type { Commenter };

export interface VisualPassDeps extends CaptureDeps {
  viewPr?: PrViewer;
  capture?: (target: { repo: string; prNumber: number; headSha: string; routes: string[] }) => Promise<CaptureOutcome>;
  comment?: Commenter;
}

const LAST_KEY = 'visual_capture_last';

function env(config: AgentWorkerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
  };
}

export function defaultPrViewer(config: AgentWorkerConfig): PrViewer {
  return async (repo, prNumber) => {
    try {
      const { stdout } = await run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid,body,files'], {
        env: env(config, config.githubReadToken),
      });
      return JSON.parse(stdout) as PrView;
    } catch (err) {
      logger.warn({ err, prNumber }, 'visual: PR read failed (skipping this pass)');
      return null;
    }
  };
}

export function defaultCommenter(config: AgentWorkerConfig): Commenter {
  return async (repo, prNumber, body) => {
    if (!config.robot.writeToken) return;
    try {
      await run('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body], { env: env(config, config.robot.writeToken) });
    } catch (err) {
      logger.warn({ err, prNumber }, 'visual: PR comment failed (the capture is still on the ticket)');
    }
  };
}

/** The served URL of one capture file, relative to the dashboard. */
export function captureUrl(prNumber: number, headSha: string, file: string): string {
  return `/api/visual-captures/pr-${prNumber}/${headSha.slice(0, 7)}/${file}`;
}

/** The PR comment: a table per route, one link per viewport × scheme. Links need DASHBOARD_PUBLIC_URL. */
export function captureComment(publicUrl: string, prNumber: number, headSha: string, outcome: Extract<CaptureOutcome, { kind: 'captured' }>): string {
  const lines = [
    '<!-- visual:captures -->',
    `**Visual: captured ${outcome.manifest.shots.length} screenshot${outcome.manifest.shots.length === 1 ? '' : 's'}** of ${headSha.slice(0, 7)} (PD-773), built from this PR and served on an empty database.`,
    '',
  ];
  if (!publicUrl) {
    lines.push('They are on the ticket timeline in the dashboard (no DASHBOARD_PUBLIC_URL is set for links here).');
    return lines.join('\n');
  }
  lines.push('| Route | Desktop light | Desktop dark | Phone light | Phone dark |', '|---|---|---|---|---|');
  for (const route of outcome.manifest.routes) {
    const cell = (vp: string, scheme: string) => {
      const s = outcome.manifest.shots.find((x) => x.route === route && x.viewport === vp && x.scheme === scheme);
      return s ? `[view](${publicUrl}${captureUrl(prNumber, headSha, s.file)})` : '—';
    };
    lines.push(`| \`${route}\` | ${cell('desktop', 'light')} | ${cell('desktop', 'dark')} | ${cell('phone', 'light')} | ${cell('phone', 'dark')} |`);
  }
  lines.push('', 'Links open on the tailnet only.');
  return lines.join('\n');
}

export async function runVisualPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: VisualPassDeps = {},
): Promise<CaptureOutcome['kind'] | null> {
  if (!config.visual.enabled) return null;
  if (now - readStateNumber(db, LAST_KEY) < config.visual.intervalMs) return null;
  writeState(db, LAST_KEY, String(now), now);
  ensureVisualCapturesTable(db);

  const view = deps.viewPr ?? defaultPrViewer(config);
  const comment = deps.comment ?? defaultCommenter(config);
  for (const target of inReviewPrTargets(db)) {
    if (target.repo !== config.githubRepo) continue;
    const pr = await view(target.repo, target.prNumber);
    if (!pr || headSettled(db, target.prNumber, pr.headRefOid)) continue;
    const files = pr.files.map((f) => f.path);
    if (!touchesWeb(files)) {
      recordCapture(db, { ticketId: target.ticketId, prNumber: target.prNumber, headSha: pr.headRefOid, outcome: 'skipped', detail: 'no web changes' }, now);
      await comment(target.repo, target.prNumber, noUiChangeComment(pr.headRefOid));
      continue;
    }
    const routes = captureRoutes(files, pr.body);
    if (routes.length === 0) routes.push('/');
    logger.info({ prNumber: target.prNumber, routes }, 'visual: capturing');
    const outcome = await (deps.capture ?? ((t) => captureVisuals(config, t, deps, now)))({
      repo: target.repo, prNumber: target.prNumber, headSha: pr.headRefOid, routes,
    });
    recordCapture(db, {
      ticketId: target.ticketId, prNumber: target.prNumber, headSha: pr.headRefOid,
      outcome: outcome.kind, detail: outcome.kind === 'failed' ? outcome.reason.slice(0, 2000) : outcome.dir,
    }, now);
    if (outcome.kind === 'captured') {
      logMilestone(db, target.ticketId, ROBOT_EVENT.visualCaptured, {
        prNumber: target.prNumber,
        shots: outcome.manifest.shots.map((s) => ({ ...s, url: captureUrl(target.prNumber, pr.headRefOid, s.file) })),
      }, now);
      await comment(target.repo, target.prNumber, captureComment(config.visual.publicUrl, target.prNumber, pr.headRefOid, outcome));
    } else {
      logger.warn({ prNumber: target.prNumber, reason: outcome.reason }, 'visual: capture failed');
      await comment(target.repo, target.prNumber, captureFailedComment(pr.headRefOid, outcome.reason));
    }
    return outcome.kind;
  }
  return null;
}
