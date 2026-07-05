import { describe, it, expect } from 'vitest';
import { resolvePageTitle } from './nav-utils';

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
    expect(resolvePageTitle('/task-monitor/tickets/PD-1')).toBe('Agent Dashboard');
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
