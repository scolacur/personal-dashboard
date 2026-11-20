import { describe, expect, it } from 'vitest';
import { captureRoutes, captureTargets, MAX_ROUTES, MAX_STEPS, parseStep, routeForComponent, routeForFile, stepLabel, targetsFromBody, routeSlug, routesFromBody, touchesWeb } from './routes';

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
  it('reads click steps after a page in the Visual: line (PD-798)', () => {
    expect(targetsFromBody('Visual: /devops/decisions, /widgets/habit-tracker > click "Habits" > click "Add metric"')).toEqual([
      { route: '/devops/decisions', steps: [] },
      { route: '/widgets/habit-tracker', steps: [{ kind: 'click', label: 'Habits' }, { kind: 'click', label: 'Add metric' }] },
    ]);
    // commas and > inside a quoted label belong to the label
    expect(targetsFromBody('Visual: /x > click "Save, then close" > click `A > B`')[0].steps).toEqual([
      { kind: 'click', label: 'Save, then close' },
      { kind: 'click', label: 'A > B' },
    ]);
  });

  it('keeps an unreadable step as invalid, so the capture reports it instead of dropping it', () => {
    expect(parseStep('hover "Menu"')).toEqual({ kind: 'invalid', raw: 'hover "Menu"' });
    expect(parseStep('click Habits')).toEqual({ kind: 'invalid', raw: 'click Habits' });
    expect(stepLabel({ kind: 'click', label: 'Habits' })).toBe('click "Habits"');
  });

  it('caps steps per page and ignores the unfilled template placeholder', () => {
    const many = Array.from({ length: MAX_STEPS + 2 }, (_, i) => `click "S${i}"`).join(' > ');
    expect(targetsFromBody(`Visual: /x > ${many}`)[0].steps).toHaveLength(MAX_STEPS);
    expect(
      targetsFromBody('Visual: <the pages your change shows up on, e.g. /devops/decisions, /widgets/habit-tracker > click "Habits"; or "none">'),
    ).toEqual([]);
  });

  it('lets the Visual: line\'s steps win over the same page found from changed files', () => {
    const files = ['apps/web/src/routes/widgets/habit-tracker/TodayList.svelte', 'apps/web/src/routes/a/+page.svelte'];
    expect(captureTargets(files, 'Visual: /widgets/habit-tracker > click "Habits"')).toEqual([
      { route: '/widgets/habit-tracker', steps: [{ kind: 'click', label: 'Habits' }] },
      { route: '/a', steps: [] },
    ]);
  });
});
