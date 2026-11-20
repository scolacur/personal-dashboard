import { describe, expect, it } from 'vitest';
import { captureRoutes, MAX_ROUTES, routeForFile, routeSlug, routesFromBody, touchesWeb } from './routes';

describe('visual routes (PD-773)', () => {
  it('maps a changed SvelteKit page to its route, dropping groups and skipping dynamic segments', () => {
    expect(routeForFile('apps/web/src/routes/+page.svelte')).toBe('/');
    expect(routeForFile('apps/web/src/routes/devops/decisions/+page.svelte')).toBe('/devops/decisions');
    expect(routeForFile('apps/web/src/routes/(app)/habits/+page.ts')).toBe('/habits');
    expect(routeForFile('apps/web/src/routes/devops/tickets/[ticketId]/+page.svelte')).toBeNull();
    expect(routeForFile('apps/web/src/lib/Button.svelte')).toBeNull();
  });

  it('reads the Visual: line, ignoring placeholders and "none"', () => {
    expect(routesFromBody('Summary\n\nVisual: /devops/decisions, `/habits`\n')).toEqual(['/devops/decisions', '/habits']);
    expect(routesFromBody('Visual: none')).toEqual([]);
    expect(routesFromBody('Visual: <the pages your change shows up on, e.g. /x>')).toEqual([]);
    expect(routesFromBody('no line')).toEqual([]);
  });

  it('puts the Visual: line first, dedupes, and caps', () => {
    const files = ['apps/web/src/routes/a/+page.svelte', 'apps/web/src/routes/b/+page.svelte', 'apps/web/src/routes/c/+page.svelte'];
    expect(captureRoutes(files, 'Visual: /b, /z, /y')).toEqual(['/b', '/z', '/y', '/a'].slice(0, MAX_ROUTES));
  });

  it('knows whether a PR touches the web app at all, and slugs routes', () => {
    expect(touchesWeb(['apps/server/src/x.ts'])).toBe(false);
    expect(touchesWeb(['apps/web/src/lib/x.svelte'])).toBe(true);
    expect(routeSlug('/')).toBe('home');
    expect(routeSlug('/devops/decisions')).toBe('devops-decisions');
  });
});
