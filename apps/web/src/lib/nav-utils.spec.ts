import { describe, it, expect } from 'vitest';
import {
  arrangeablePageId,
  isDevOpsRoute,
  navTapClosesDrawer,
  resolvePageTitle,
} from './nav-utils';

describe('resolvePageTitle', () => {
  it('returns "Home" for the root path', () => {
    expect(resolvePageTitle('/')).toBe('Home');
  });

  it('returns the exact page title for a top-level route', () => {
    expect(resolvePageTitle('/productivity')).toBe('Productivity');
    expect(resolvePageTitle('/health-fitness')).toBe('Health / Fitness');
    expect(resolvePageTitle('/music-discovery')).toBe('Music Discovery');
  });

  it('matches the nav page when the pathname is a sub-path', () => {
    expect(resolvePageTitle('/devops/tickets/PD-1')).toBe('Dev Ops');
    expect(resolvePageTitle('/productivity/some-subpage')).toBe('Productivity');
  });

  it('returns "Dashboard" for unknown routes', () => {
    expect(resolvePageTitle('/widgets/music-tracker')).toBe('Dashboard');
    expect(resolvePageTitle('/unknown')).toBe('Dashboard');
  });

  it('does not match "/" as a prefix for other routes', () => {
    // The root route should only match exactly "/", not "/productivity".
    expect(resolvePageTitle('/productivity')).not.toBe('Home');
  });
});

describe('arrangeablePageId', () => {
  it('resolves the root path to the home grid', () => {
    expect(arrangeablePageId('/')).toBe('home');
  });

  it('resolves a top-level page route to its own grid', () => {
    expect(arrangeablePageId('/devops')).toBe('devops');
    expect(arrangeablePageId('/productivity')).toBe('productivity');
  });

  it('resolves no grid for a subroute — it is its own view, not the parent page grid', () => {
    // The Kanban in particular: dragging there reorders tickets, not widgets. A prefix
    // match would light Arrange up on all of these (PD-413).
    expect(arrangeablePageId('/devops/task-tracker')).toBeUndefined();
    expect(arrangeablePageId('/devops/jobs')).toBeUndefined();
    expect(arrangeablePageId('/devops/agent-dashboard')).toBeUndefined();
    expect(arrangeablePageId('/devops/tickets/PD-1')).toBeUndefined();
  });

  it('resolves no grid for unknown routes', () => {
    expect(arrangeablePageId('/widgets/music-tracker')).toBeUndefined();
    expect(arrangeablePageId('/unknown')).toBeUndefined();
  });
});

describe('isDevOpsRoute', () => {
  it('matches the Dev Ops section root and all its subroutes', () => {
    expect(isDevOpsRoute('/devops')).toBe(true);
    expect(isDevOpsRoute('/devops/task-tracker')).toBe(true);
    expect(isDevOpsRoute('/devops/jobs')).toBe(true);
    expect(isDevOpsRoute('/devops/agent-dashboard')).toBe(true);
    expect(isDevOpsRoute('/devops/tickets/PD-1')).toBe(true);
    expect(isDevOpsRoute('/devops/reports/ticket-audit')).toBe(true);
  });

  it('does not match other routes', () => {
    expect(isDevOpsRoute('/')).toBe(false);
    expect(isDevOpsRoute('/productivity')).toBe(false);
  });

  it('does not match a route that merely starts with the same characters', () => {
    // `/devops-notes` is not inside the section — the boundary is the slash.
    expect(isDevOpsRoute('/devops-notes')).toBe(false);
  });

  it('is a prefix match where arrangeablePageId is exact — the two must not be unified', () => {
    // Deploy state is section-wide context; Arrange applies only to the actual widget grid.
    expect(isDevOpsRoute('/devops/task-tracker')).toBe(true);
    expect(arrangeablePageId('/devops/task-tracker')).toBeUndefined();
  });
});

describe('navTapClosesDrawer', () => {
  it('keeps the mobile drawer open when tapping a parent with children', () => {
    // Dev Ops drills into a sub-panel that slides in within the drawer — closing it would
    // hide that panel (the bug this fixes).
    expect(navTapClosesDrawer(true)).toBe(false);
  });

  it('closes the mobile drawer when tapping a leaf link', () => {
    // A leaf navigates away, so the drawer should close behind it.
    expect(navTapClosesDrawer(false)).toBe(true);
  });
});

describe('the Library page (PD-334)', () => {
  it('resolves its title without being in pages.ts', () => {
    expect(resolvePageTitle('/library')).toBe('All Widgets');
  });

  it('is not Arrange-able', () => {
    // It is a derived view, not a curated page — no membership to arrange. This holds because
    // the route is absent from `pages.ts`, not because of a special case.
    expect(arrangeablePageId('/library')).toBeUndefined();
  });
});
