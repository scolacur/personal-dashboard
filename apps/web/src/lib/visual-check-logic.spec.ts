import { describe, expect, it } from 'vitest';
import type { VisualCaptureState } from '@dashboard/shared';
import { askedBy, captureNotice, rejectBlocked, shotsByRoute, stepFailureLines, waitedFor, type Shot } from './visual-check-logic';

const shot = (route: string, viewport: string, scheme: string): Shot => ({ route, viewport, scheme, file: `${route}-${viewport}-${scheme}.png`, url: '/x' });

describe('visual check logic (PD-773)', () => {
  it('groups shots by route in desktop/phone × light/dark order', () => {
    const g = shotsByRoute([shot('/a', 'phone', 'dark'), shot('/b', 'desktop', 'light'), shot('/a', 'desktop', 'light'), shot('/a', 'desktop', 'dark')]);
    expect(g.map((x) => x.route)).toEqual(['/a', '/b']);
    expect(g[0].shots.map((s) => `${s.viewport}-${s.scheme}`)).toEqual(['desktop-light', 'desktop-dark', 'phone-dark']);
  });

  it('gives each click step its own group after its page, captioned with the step (PD-798)', () => {
    const step = (route: string, idx: number, label: string, viewport = 'desktop'): Shot => ({
      ...shot(route, viewport, 'light'),
      file: `${route}-s${idx}-${viewport}.png`,
      step: label,
      stepIndex: idx,
    });
    const g = shotsByRoute([
      step('/h', 2, 'click "Add metric"'),
      shot('/b', 'desktop', 'light'),
      step('/h', 1, 'click "Habits"', 'phone'),
      shot('/h', 'desktop', 'light'),
      step('/h', 1, 'click "Habits"'),
    ]);
    expect(g.map((x) => x.heading)).toEqual(['/h', '/h › click "Habits"', '/h › click "Add metric"', '/b']);
    expect(g[1].shots.map((s) => s.viewport)).toEqual(['desktop', 'phone']);
    expect(new Set(g.map((x) => x.key)).size).toBe(g.length);
  });

  it('lists the click steps that could not run', () => {
    expect(stepFailureLines({ stepFailures: [{ route: '/h', step: 'click "Nope"', reason: 'nothing on the page is named "Nope"' }] })).toEqual([
      '/h › click "Nope": nothing on the page is named "Nope"',
    ]);
    expect(stepFailureLines({ stepFailures: [] })).toEqual([]);
  });

  it('requires a note to request changes', () => {
    expect(rejectBlocked('  ')).toMatch(/what to change/);
    expect(rejectBlocked('Tighten the header')).toBeNull();
  });

  it('names who asked, once each', () => {
    expect(askedBy({ reasons: [{ by: 'robot', reason: 'a' }, { by: 'evaluator', reason: 'b' }, { by: 'robot', reason: 'c' }] })).toBe('the Robot and the Evaluator');
  });
});

describe('capture notice (PD-794)', () => {
  const NOW = 10_000_000;
  const notice = (capture: VisualCaptureState, shots: Shot[] = []) => captureNotice({ capture, shots }, NOW);
  const STILL = /still being captured/;

  it('says nothing when the screenshots are there', () => {
    expect(notice({ kind: 'captured' }, [shot('/a', 'desktop', 'light')])).toBeNull();
  });

  it('flags a capture that recorded no screenshots', () => {
    expect(notice({ kind: 'captured' })).toMatchObject({ tone: 'warn', text: expect.stringMatching(/no screenshots/) });
  });

  it('capturing: says the head is queued and how long it has waited', () => {
    expect(notice({ kind: 'capturing', since: NOW - 4 * 60_000 })).toEqual({ tone: 'info', text: expect.stringMatching(/queued.*waiting 4 min/) });
  });

  it('off: says so plainly and names the setting', () => {
    const n = notice({ kind: 'off' });
    expect(n?.tone).toBe('warn');
    expect(n?.text).toMatch(/Capture is off/);
    expect(n?.text).toContain('VISUAL_CAPTURE_ENABLED');
  });

  it('failed: shows the reason', () => {
    expect(notice({ kind: 'failed', reason: 'vite build exited 1' })).toEqual({ tone: 'warn', text: expect.stringContaining('vite build exited 1') });
  });

  it('skipped: says why', () => {
    expect(notice({ kind: 'skipped', reason: 'no web changes' })?.text).toMatch(/skipped.*no web changes/);
  });

  it('unknown: says the state is unknown, with when the worker last reported', () => {
    expect(notice({ kind: 'unknown', lastSeen: null })?.text).toMatch(/unknown.*has not reported/);
    expect(notice({ kind: 'unknown', lastSeen: NOW - 125 * 60_000 })?.text).toMatch(/last reported 2 h 5 min ago/);
  });

  it('never falls back to "still being captured"', () => {
    const states: VisualCaptureState[] = [
      { kind: 'captured' },
      { kind: 'capturing', since: NOW },
      { kind: 'off' },
      { kind: 'failed', reason: 'x' },
      { kind: 'skipped', reason: 'x' },
      { kind: 'unknown', lastSeen: null },
    ];
    for (const s of states) expect(notice(s)?.text ?? '').not.toMatch(STILL);
  });

  it('formats waits', () => {
    expect(waitedFor(10_000)).toBe('under a minute');
    expect(waitedFor(60 * 60_000)).toBe('1 h');
  });
});
