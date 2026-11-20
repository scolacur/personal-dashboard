/**
 * Which pages a visual capture photographs (PD-773). Pure.
 *
 * Two sources, in order:
 *  1. a `Visual: /a, /b` line in the PR body. The Robot adds it at hand-off when its change is
 *     visual (it knows which pages it touched, including ones only a shared component reaches);
 *  2. every changed SvelteKit page (`apps/web/src/routes/<path>/+page.svelte`), with route groups
 *     like `(app)` dropped. Dynamic segments (`[id]`) cannot be filled in, so those pages are left
 *     to the `Visual:` line.
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

export function routesFromBody(body: string): string[] {
  const line = /^\s*Visual(?: routes)?:\s*(.+)$/im.exec(body ?? '');
  if (!line) return [];
  return line[1]
    .split(/[\s,]+/)
    .map((t) => t.replace(/[`'"]/g, ''))
    .filter((t) => /^\/[A-Za-z0-9/_\-.]*$/.test(t));
}

export function captureRoutes(files: readonly string[], body: string): string[] {
  const out: string[] = [];
  for (const r of [...routesFromBody(body), ...files.map(routeForFile)]) {
    if (r && !out.includes(r)) out.push(r);
  }
  return out.slice(0, MAX_ROUTES);
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
