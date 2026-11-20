import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { routeSlug, stepLabel, type CaptureTarget } from './routes';

/**
 * The screenshot step of a visual capture (PD-773), as its own process.
 *
 * Spawned by the worker DROPPED to the Robot's uid with the allowlisted env, because it renders the
 * PR's own front end, which nobody has reviewed yet. The browser may only talk to the PR's server
 * on localhost: every other request is aborted, so a page cannot reach out (and the egress proxy
 * would refuse it anyway). `--no-sandbox` is required for Chromium in this container; the dropped
 * uid and the container are the boundary instead.
 *
 * PD-798: after photographing a page as it loads, each of its click steps runs in order, cumulatively
 * (a tab, then a button inside it), with a screenshot after each. A step that cannot run is recorded
 * as a failure with its reason, and the steps after it on that page are recorded as not run: the
 * capture never quietly photographs less than it was asked to.
 *
 * Usage: node capture-cli.js '<json>' with { baseUrl, targets, outDir, chromiumPath }.
 * Prints { shots, failures } as JSON.
 */

export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;
export const SCHEMES = ['light', 'dark'] as const;

export interface WrittenShot {
  route: string;
  viewport: string;
  scheme: string;
  file: string;
  step?: string;
  stepIndex?: number;
}
export interface Failure {
  route: string;
  step: string;
  reason: string;
}

export function shotName(route: string, viewport: string, scheme: string, stepIndex = 0): string {
  return `${routeSlug(route)}${stepIndex > 0 ? `-s${stepIndex}` : ''}-${viewport}-${scheme}.png`;
}

/** The page surface the step runner needs; Playwright's `Page` satisfies it, and specs fake it. */
export interface StepPage {
  getByRole: Page['getByRole'];
  getByText: Page['getByText'];
  waitForLoadState: Page['waitForLoadState'];
  waitForTimeout: Page['waitForTimeout'];
}

const STEP_TIMEOUT_MS = 5_000;
const CLICK_ROLES = ['tab', 'button', 'link', 'menuitem', 'option', 'checkbox', 'radio'] as const;

/** Click the first control named `label`: by role first (exact accessible name), then visible text. */
export async function clickByLabel(page: StepPage, label: string): Promise<void> {
  for (const role of CLICK_ROLES) {
    const loc = page.getByRole(role, { name: label, exact: true });
    if ((await loc.count()) > 0) {
      await loc.first().click({ timeout: STEP_TIMEOUT_MS });
      return;
    }
  }
  const text = page.getByText(label, { exact: true });
  if ((await text.count()) > 0) {
    await text.first().click({ timeout: STEP_TIMEOUT_MS });
    return;
  }
  throw new Error(`nothing on the page is named "${label}"`);
}

/**
 * Run one page's steps after it has loaded, calling `shoot(stepIndex, label)` after each that worked.
 * Returns the failures: the step that broke, and every step after it as not run.
 */
export async function runSteps(
  page: StepPage,
  target: CaptureTarget,
  shoot: (stepIndex: number, label: string) => Promise<void>,
): Promise<Failure[]> {
  const failures: Failure[] = [];
  for (const [i, step] of target.steps.entries()) {
    const label = stepLabel(step);
    if (failures.length > 0) {
      failures.push({ route: target.route, step: label, reason: 'not run: an earlier step on this page failed' });
      continue;
    }
    if (step.kind === 'invalid') {
      failures.push({ route: target.route, step: label, reason: 'not a step the capture understands (use: click "Label")' });
      continue;
    }
    try {
      await clickByLabel(page, step.label);
      await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      await page.waitForTimeout(400); // let a modal or tab transition finish
      await shoot(i + 1, label);
    } catch (err) {
      failures.push({ route: target.route, step: label, reason: (err instanceof Error ? err.message : String(err)).split('\n')[0] });
    }
  }
  return failures;
}

/** Failures are found once per viewport × scheme; report each route + step once. */
export function dedupeFailures(failures: readonly Failure[]): Failure[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.route}\u0000${f.step}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main(): Promise<void> {
  const args = JSON.parse(process.argv[2] ?? '{}') as { baseUrl: string; targets: CaptureTarget[]; outDir: string; chromiumPath?: string };
  mkdirSync(args.outDir, { recursive: true });
  const base = new URL(args.baseUrl);
  const browser = await chromium.launch({
    executablePath: args.chromiumPath || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const shots: WrittenShot[] = [];
  const failures: Failure[] = [];
  try {
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
        await context.route('**/*', (route) => {
          const u = new URL(route.request().url());
          return u.host === base.host ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        for (const t of args.targets) {
          try {
            await page.goto(new URL(t.route, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 });
          } catch {
            // A page that never goes idle (polling) is still worth a picture of what it rendered.
          }
          const shoot = async (stepIndex: number, step?: string) => {
            const file = shotName(t.route, vp.name, scheme, stepIndex);
            await page.screenshot({ path: path.join(args.outDir, file), fullPage: false });
            shots.push({ route: t.route, viewport: vp.name, scheme, file, ...(step ? { step, stepIndex } : {}) });
          };
          await shoot(0);
          failures.push(...(await runSteps(page, t, shoot)));
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(JSON.stringify({ shots, failures: dedupeFailures(failures) }));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err));
    process.exit(1);
  });
}
