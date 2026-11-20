import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { routeSlug } from './routes';

/**
 * The screenshot step of a visual capture (PD-773), as its own process.
 *
 * Spawned by the worker DROPPED to the Robot's uid with the allowlisted env, because it renders the
 * PR's own front end, which nobody has reviewed yet. The browser may only talk to the PR's server
 * on localhost: every other request is aborted, so a page cannot reach out (and the egress proxy
 * would refuse it anyway). `--no-sandbox` is required for Chromium in this container; the dropped
 * uid and the container are the boundary instead.
 *
 * Usage: node capture-cli.js '<json>' with { baseUrl, routes, outDir, chromiumPath }.
 * Prints a JSON array of the files written, one per route × viewport × scheme.
 */

export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;
export const SCHEMES = ['light', 'dark'] as const;

export function shotName(route: string, viewport: string, scheme: string): string {
  return `${routeSlug(route)}-${viewport}-${scheme}.png`;
}

async function main(): Promise<void> {
  const args = JSON.parse(process.argv[2] ?? '{}') as { baseUrl: string; routes: string[]; outDir: string; chromiumPath?: string };
  mkdirSync(args.outDir, { recursive: true });
  const base = new URL(args.baseUrl);
  const browser = await chromium.launch({
    executablePath: args.chromiumPath || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const written: { route: string; viewport: string; scheme: string; file: string }[] = [];
  try {
    for (const vp of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });
        await context.route('**/*', (route) => {
          const u = new URL(route.request().url());
          return u.host === base.host ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        for (const r of args.routes) {
          try {
            await page.goto(new URL(r, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 });
          } catch {
            // A page that never goes idle (polling) is still worth a picture of what it rendered.
          }
          const file = shotName(r, vp.name, scheme);
          await page.screenshot({ path: path.join(args.outDir, file), fullPage: false });
          written.push({ route: r, viewport: vp.name, scheme, file });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(JSON.stringify(written));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err));
    process.exit(1);
  });
}
