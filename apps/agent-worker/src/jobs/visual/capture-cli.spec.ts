import { describe, expect, it } from 'vitest';
import { dedupeFailures, runSteps, shotName, type StepPage } from './capture-cli';
import type { CaptureTarget } from './routes';

/** A page whose controls are just names; clicking one records it. */
function fakePage(named: { role?: string; text?: string }[], clicks: string[]): StepPage {
  const locator = (match: (n: { role?: string; text?: string }) => boolean, label: string) => ({
    count: async () => named.filter(match).length,
    first: () => ({ click: async () => void clicks.push(label) }),
  });
  return {
    getByRole: ((role: string, opts: { name: string }) => locator((n) => n.role === role && n.text === opts.name, opts.name)) as unknown as StepPage['getByRole'],
    getByText: ((text: string) => locator((n) => n.role === undefined && n.text === text, text)) as unknown as StepPage['getByText'],
    waitForLoadState: (async () => undefined) as StepPage['waitForLoadState'],
    waitForTimeout: (async () => undefined) as StepPage['waitForTimeout'],
  };
}

const target = (steps: CaptureTarget['steps']): CaptureTarget => ({ route: '/widgets/habit-tracker', steps });

describe('capture-cli steps (PD-798)', () => {
  it('names step shots after their position on the page', () => {
    expect(shotName('/widgets/habit-tracker', 'desktop', 'dark')).toBe('widgets-habit-tracker-desktop-dark.png');
    expect(shotName('/widgets/habit-tracker', 'phone', 'light', 2)).toBe('widgets-habit-tracker-s2-phone-light.png');
  });

  it('clicks each step in order, by role first then visible text, and shoots after each', async () => {
    const clicks: string[] = [];
    const shots: [number, string][] = [];
    const page = fakePage([{ role: 'tab', text: 'Habits' }, { text: 'Add metric' }], clicks);
    const failures = await runSteps(
      page,
      target([{ kind: 'click', label: 'Habits' }, { kind: 'click', label: 'Add metric' }]),
      async (i, label) => void shots.push([i, label]),
    );
    expect(failures).toEqual([]);
    expect(clicks).toEqual(['Habits', 'Add metric']);
    expect(shots).toEqual([[1, 'click "Habits"'], [2, 'click "Add metric"']]);
  });

  it('records a missing control, and every step after it as not run', async () => {
    const shots: number[] = [];
    const failures = await runSteps(
      fakePage([{ role: 'button', text: 'Habits' }], []),
      target([{ kind: 'click', label: 'Nope' }, { kind: 'click', label: 'Habits' }]),
      async (i) => void shots.push(i),
    );
    expect(shots).toEqual([]);
    expect(failures).toEqual([
      { route: '/widgets/habit-tracker', step: 'click "Nope"', reason: 'nothing on the page is named "Nope"' },
      { route: '/widgets/habit-tracker', step: 'click "Habits"', reason: 'not run: an earlier step on this page failed' },
    ]);
  });

  it('reports a step it cannot read instead of skipping it', async () => {
    const failures = await runSteps(fakePage([], []), target([{ kind: 'invalid', raw: 'hover "Menu"' }]), async () => undefined);
    expect(failures[0]).toMatchObject({ step: 'hover "Menu"', reason: expect.stringContaining('click "Label"') });
  });

  it('reports each failed step once across viewports and schemes', () => {
    const f = { route: '/x', step: 'click "A"', reason: 'r' };
    expect(dedupeFailures([f, { ...f }, { ...f, step: 'click "B"' }])).toHaveLength(2);
  });
});
