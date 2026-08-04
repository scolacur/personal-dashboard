import { describe, it, expect } from 'vitest';
import { arrangeablePageId, resolvePageTitle } from './nav-utils';

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
