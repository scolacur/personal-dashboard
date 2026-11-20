import { describe, expect, it } from 'vitest';
import { askedBy, rejectBlocked, shotsByRoute, type Shot } from './visual-check-logic';

const shot = (route: string, viewport: string, scheme: string): Shot => ({ route, viewport, scheme, file: `${route}-${viewport}-${scheme}.png`, url: '/x' });

describe('visual check logic (PD-773)', () => {
  it('groups shots by route in desktop/phone × light/dark order', () => {
    const g = shotsByRoute([shot('/a', 'phone', 'dark'), shot('/b', 'desktop', 'light'), shot('/a', 'desktop', 'light'), shot('/a', 'desktop', 'dark')]);
    expect(g.map((x) => x.route)).toEqual(['/a', '/b']);
    expect(g[0].shots.map((s) => `${s.viewport}-${s.scheme}`)).toEqual(['desktop-light', 'desktop-dark', 'phone-dark']);
  });

  it('requires a note to request changes', () => {
    expect(rejectBlocked('  ')).toMatch(/what to change/);
    expect(rejectBlocked('Tighten the header')).toBeNull();
  });

  it('names who asked, once each', () => {
    expect(askedBy({ reasons: [{ by: 'robot', reason: 'a' }, { by: 'evaluator', reason: 'b' }, { by: 'robot', reason: 'c' }] })).toBe('the Robot and the Evaluator');
  });
});
