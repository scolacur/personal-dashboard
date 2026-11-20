import { describe, expect, it } from 'vitest';
import { captureRoutes, MAX_ROUTES, routeForComponent, routeForFile, routeSlug, routesFromBody, touchesWeb } from './routes';

describe('visual routes (PD-773)', () => {
  it('maps a changed SvelteKit page to its route, dropping groups and skipping dynamic segments', () => {
    expect(routeForFile('apps/web/src/routes/+page.svelte')).toBe('/');
    expect(routeForFile('apps/web/src/routes/devops/decisions/+page.svelte')).toBe('/devops/decisions');
    expect(routeForFile('apps/web/src/routes/(app)/habits/+page.ts')).toBe('/habits');
    expect(routeForFile('apps/web/src/routes/devops/tickets/[ticketId]/+page.svelte')).toBeNull();
    expect(routeForFile('apps/web/src/lib/Button.svelte')).toBeNull();
  });

  it('maps a changed component colocated in a route folder to that folder\'s route', () => {
    expect(routeForComponent('apps/web/src/routes/widgets/habit-tracker/TodayList.svelte')).toBe('/widgets/habit-tracker');
    expect(routeForComponent('apps/web/src/routes/(app)/habits/Row.scss')).toBe('/habits');
    expect(routeForComponent('apps/web/src/routes/widgets/habit-tracker/api.ts')).toBe('/widgets/habit-tracker');
    expect(routeForComponent('apps/web/src/routes/widgets/habit-tracker/queue.spec.ts')).toBeNull();
    expect(routeForComponent('apps/web/src/routes/widgets/habit-tracker/+page.svelte')).toBeNull();
    expect(routeForComponent('apps/web/src/routes/devops/tickets/[ticketId]/Thread.svelte')).toBeNull();
    expect(routeForComponent('apps/web/src/lib/Button.svelte')).toBeNull();
  });

  it('photographs the page whose components changed, not the home page (#449)', () => {
    const files = [
      'apps/server/src/lib/habits.ts',
      'apps/web/src/lib/HabitTracker.svelte',
      'apps/web/src/routes/widgets/habit-tracker/MetricEditor.svelte',
      'apps/web/src/routes/widgets/habit-tracker/TodayList.scss',
      'apps/web/src/routes/widgets/habit-tracker/queue.spec.ts',
    ];
    expect(captureRoutes(files, '')).toEqual(['/widgets/habit-tracker']);
    // a changed page outranks a page reached only through its components
    expect(captureRoutes(['apps/web/src/routes/b/X.svelte', 'apps/web/src/routes/a/+page.svelte'], '')).toEqual(['/a', '/b']);
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
