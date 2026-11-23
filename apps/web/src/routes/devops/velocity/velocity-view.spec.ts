import { describe, it, expect } from 'vitest';
import {
  parseProjectParam,
  projectSearch,
  defaultEpicId,
  groupEpics,
  niceScale,
  robotShare,
  sliceRange,
  spreadLabels,
  tickIndices,
} from './velocity-view';

describe('niceScale', () => {
  it('rounds the ceiling up to a nice step', () => {
    expect(niceScale(37)).toEqual({ max: 40, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(0.83).max).toBe(1);
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(260).max).toBe(300);
  });
});

describe('sliceRange', () => {
  it('keeps the trailing weeks', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    expect(sliceRange(xs, '8w')).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
    expect(sliceRange(xs, 'all')).toHaveLength(30);
  });
});

describe('robotShare', () => {
  it('excludes unassigned and handles zero', () => {
    expect(robotShare({ robot: 1, steve: 3, unassigned: 99 })).toBe(0.25);
    expect(robotShare({ robot: 0, steve: 0, unassigned: 5 })).toBeNull();
  });
});

describe('tickIndices', () => {
  it('spaces labels and always ends on the latest week', () => {
    expect(tickIndices(22, 300, 64)).toEqual([3, 9, 15, 21]); // 4 labels fit → every 6th
    expect(tickIndices(3, 600)).toEqual([0, 1, 2]);
    expect(tickIndices(0, 300)).toEqual([]);
  });
});

describe('spreadLabels', () => {
  it('pushes colliding labels apart and keeps them inside the plot', () => {
    expect(spreadLabels([50, 52, 100], 12, 0, 200)).toEqual([50, 62, 100]);
    expect(spreadLabels([195, 198], 12, 0, 200)).toEqual([188, 200]);
  });
});

describe('defaultEpicId / groupEpics', () => {
  const e = (id: number, status: string) => ({
    id,
    status,
    displayId: `PD-${id}`,
    title: '',
    memberCount: 1,
    lastActivity: 0,
    now: { open: 0, done: 0, dropped: 0 },
    weeks: [],
  });
  it('opens on the most recent open Epic, falling back to the most recent of any', () => {
    expect(defaultEpicId([e(1, 'completed'), e(2, 'queue'), e(3, 'backlog')])).toBe(2);
    expect(defaultEpicId([e(1, 'completed')])).toBe(1);
    expect(defaultEpicId([])).toBeNull();
  });
  it('groups open vs finished in order', () => {
    const g = groupEpics([e(1, 'closed'), e(2, 'queue'), e(3, 'completed'), e(4, 'backlog')]);
    expect(g.open.map((x) => x.id)).toEqual([2, 4]);
    expect(g.finished.map((x) => x.id)).toEqual([1, 3]);
  });
});

describe('project filter param (PD-922)', () => {
  it('parses a positive integer id and rejects anything else', () => {
    expect(parseProjectParam('4')).toBe(4);
    for (const raw of [null, '', '0', '-1', '1.5', 'abc', '2x']) {
      expect(parseProjectParam(raw)).toBeUndefined();
    }
  });

  it('sets, replaces and clears the project, keeping other params', () => {
    expect(projectSearch(new URLSearchParams(''), 3)).toBe('?project=3');
    expect(projectSearch(new URLSearchParams('project=1&x=y'), 2)).toBe('?project=2&x=y');
    expect(projectSearch(new URLSearchParams('project=1&x=y'), undefined)).toBe('?x=y');
    expect(projectSearch(new URLSearchParams('project=1'), undefined)).toBe('');
  });
});
