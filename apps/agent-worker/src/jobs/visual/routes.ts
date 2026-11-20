/**
 * Which pages a visual capture photographs (PD-773). Pure.
 *
 * Sources, in order:
 *  1. a `Visual: /a, /b > click "Tab"` line in the PR body. The Robot adds it at hand-off when its
 *     change is visual (it knows which pages it touched, including ones only a shared component
 *     reaches), with click steps for anything behind a tab or a modal (PD-798);
 *  2. every changed SvelteKit page (`apps/web/src/routes/<path>/+page.svelte`), with route groups
 *     like `(app)` dropped. Dynamic segments (`[id]`) cannot be filled in, so those pages are left
 *     to the `Visual:` line;
 *  3. every route folder whose colocated components changed (`routes/widgets/habit-tracker/
 *     TodayList.svelte` → `/widgets/habit-tracker`). Every route folder here that holds components
 *     also has its own `+page.svelte`, so the folder IS the page that renders them. Without this, a
 *     PR that only touched a page's components photographed the home page instead (#449, 2026-11-20).
 * Capped, because each route costs four screenshots.
 */

export const MAX_ROUTES = 4;

const ROUTE_FILE = /^apps\/web\/src\/routes\/(.*?)\/?\+page(?:\.svelte|\.ts|\.scss)$/;

export function routeForFile(path: string): string | null {
  const m = ROUTE_FILE.exec(path);
  if (!m) return null;
  const segments = m[1].split('/').filter((s) => s !== '' && !/^\(.*\)$/.test(s));
  if (segments.some((s) => s.includes('['))) return null;
  return `/${segments.join('/')}`;
}

const ROUTE_COMPONENT = /^apps\/web\/src\/routes\/(.*)\/[^/+][^/]*\.(?:svelte|scss|ts)$/;
const TEST_FILE = /\.(?:spec|test)\.ts$/;

/** A changed component colocated in a route folder → that folder's route; null otherwise. */
export function routeForComponent(path: string): string | null {
  if (TEST_FILE.test(path)) return null;
  const m = ROUTE_COMPONENT.exec(path);
  if (!m) return null;
  const segments = m[1].split('/').filter((s) => s !== '' && !/^\(.*\)$/.test(s));
  if (segments.some((s) => s.includes('['))) return null;
  return `/${segments.join('/')}`;
}

/**
 * One step after a page loads (PD-798): click the control whose accessible name or visible text is
 * `label`. A step the parser cannot read is kept as `invalid`, so the capture reports it instead of
 * silently photographing less than the Robot asked for.
 */
export type CaptureStep = { kind: 'click'; label: string } | { kind: 'invalid'; raw: string };

/** A page to photograph, then each step's result in order (steps run cumulatively). */
export interface CaptureTarget {
  route: string;
  steps: CaptureStep[];
}

/** Steps per route: each one adds four screenshots and a few seconds. */
export const MAX_STEPS = 4;

/** Split on `sep` outside double quotes or backticks. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
    } else if (ch === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const CLICK_STEP = /^click\s+(?:"([^"]+)"|`([^`]+)`)$/i;
const ROUTE_TOKEN = /^\/[A-Za-z0-9/_\-.]*$/;

export function parseStep(raw: string): CaptureStep {
  const m = CLICK_STEP.exec(raw.trim());
  return m ? { kind: 'click', label: (m[1] ?? m[2]).trim() } : { kind: 'invalid', raw: raw.trim() };
}

/** A step as the card and the PR comment caption it: `click "Add metric"`. */
export function stepLabel(step: CaptureStep): string {
  return step.kind === 'click' ? `click "${step.label}"` : step.raw;
}

/**
 * The `Visual:` line: pages separated by commas, each optionally followed by `>`-separated steps.
 *   Visual: /devops/decisions, /widgets/habit-tracker > click "Habits" > click "Add metric"
 * Entries whose first token is not a route (placeholders, "none") are dropped.
 */
export function targetsFromBody(body: string): CaptureTarget[] {
  const line = /^\s*Visual(?: routes)?:\s*(.+)$/im.exec(body ?? '');
  if (!line) return [];
  // The template's placeholder itself (`<the pages…>`), left unfilled, names example pages: ignore it.
  if (line[1].trim().startsWith('<')) return [];
  const out: CaptureTarget[] = [];
  for (const entry of splitOutsideQuotes(line[1], ',')) {
    const [head, ...steps] = splitOutsideQuotes(entry, '>');
    const route = (head ?? '').replace(/[`'"]/g, '');
    if (!ROUTE_TOKEN.test(route)) continue;
    out.push({ route, steps: steps.slice(0, MAX_STEPS).map(parseStep) });
  }
  return out;
}

/** The routes alone, as before steps existed. */
export function routesFromBody(body: string): string[] {
  return targetsFromBody(body).map((t) => t.route);
}

/** What to photograph: the `Visual:` line first (with its steps), then changed pages, then the route
 *  folders of changed components. One target per route; the `Visual:` line's wins. Capped. */
export function captureTargets(files: readonly string[], body: string): CaptureTarget[] {
  const out: CaptureTarget[] = [];
  const add = (t: CaptureTarget) => {
    if (!out.some((o) => o.route === t.route)) out.push(t);
  };
  for (const t of targetsFromBody(body)) add(t);
  for (const r of [...files.map(routeForFile), ...files.map(routeForComponent)]) if (r) add({ route: r, steps: [] });
  return out.slice(0, MAX_ROUTES);
}

export function captureRoutes(files: readonly string[], body: string): string[] {
  return captureTargets(files, body).map((t) => t.route);
}

/** Whether a PR changes anything the web app renders, so it is worth photographing at all. */
export function touchesWeb(files: readonly string[]): boolean {
  return files.some((f) => f.startsWith('apps/web/src/') || f.startsWith('packages/shared/src/'));
}

/** `/devops/decisions` → `devops-decisions`; `/` → `home`. File-name safe. */
export function routeSlug(route: string): string {
  const s = route.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-');
  return s === '' ? 'home' : s;
}
