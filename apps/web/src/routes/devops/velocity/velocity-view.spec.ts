import { describe, it, expect } from 'vitest';
import { niceScale, robotShare, sliceRange, spreadLabels, tickIndices } from './velocity-view';

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
