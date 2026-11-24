import { describe, it, expect } from 'vitest';
import {
  flattenNavTree,
  moveNavPage,
  navPagePath,
  resolveNavPath,
  type NavPage,
} from '@dashboard/shared';
import { computeDrop, dropAtEnd, isNoopDrop } from './nav-drop';

// PD-969 (nav pages become data): the shared tree helpers and the Spotify-style drop zones.

const page = (id: string, parentId: string | null, order: number): NavPage => ({
  id,
  title: id.toUpperCase(),
  description: '',
  slug: id,
  parentId,
  order,
});

//  a
//  b
//    b1
//    b2
//  c
const PAGES: NavPage[] = [
  page('a', null, 0),
  page('b', null, 1),
  page('c', null, 2),
  page('b1', 'b', 0),
  page('b2', 'b', 1),
];
const ROWS = flattenNavTree(PAGES);
const rowOf = (id: string) => ROWS.findIndex((r) => r.page.id === id);

describe('flattenNavTree', () => {
  it('lists depth-first with depths and child flags', () => {
    expect(ROWS.map((r) => `${r.page.id}:${r.depth}:${r.hasChildren ? 'p' : '-'}`)).toEqual([
      'a:0:-',
      'b:0:p',
      'b1:1:-',
      'b2:1:-',
      'c:0:-',
    ]);
  });

  it('does not hang on a corrupt cycle', () => {
    const cyc = [page('x', 'y', 0), page('y', 'x', 0), page('z', null, 0)];
    expect(flattenNavTree(cyc).map((r) => r.page.id)).toEqual(['z']);
  });
});

describe('moveNavPage', () => {
  it('reorders siblings, renumbering contiguously', () => {
    const r = moveNavPage(PAGES, 'c', null, 0);
    if ('error' in r) throw new Error(r.error);
    expect(
      flattenNavTree(r.pages)
        .filter((x) => x.depth === 0)
        .map((x) => [x.page.id, x.page.order]),
    ).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('moves a parent with its children', () => {
    const r = moveNavPage(PAGES, 'b', 'a', 0);
    if ('error' in r) throw new Error(r.error);
    expect(flattenNavTree(r.pages).map((x) => `${x.page.id}:${x.depth}`)).toEqual([
      'a:0',
      'b:1',
      'b1:2',
      'b2:2',
      'c:0',
    ]);
  });

  it('un-nests a child', () => {
    const r = moveNavPage(PAGES, 'b2', null, 3);
    if ('error' in r) throw new Error(r.error);
    expect(flattenNavTree(r.pages).map((x) => `${x.page.id}:${x.depth}`)).toEqual([
      'a:0',
      'b:0',
      'b1:1',
      'c:0',
      'b2:0',
    ]);
  });

  it('refuses cycles and unknown ids', () => {
    expect(moveNavPage(PAGES, 'b', 'b1', 0)).toEqual({ error: 'CYCLE' });
    expect(moveNavPage(PAGES, 'b', 'b', 0)).toEqual({ error: 'CYCLE' });
    expect(moveNavPage(PAGES, 'zz', null, 0)).toEqual({ error: 'NOT_FOUND' });
    expect(moveNavPage(PAGES, 'a', 'zz', 0)).toEqual({ error: 'PARENT_NOT_FOUND' });
  });
});

describe('paths', () => {
  it('builds a nested path from ancestor slugs', () => {
    expect(navPagePath(PAGES, 'b2')).toBe('/p/b/b2');
    expect(navPagePath(PAGES, 'a')).toBe('/p/a');
  });

  it('resolves a stale path by its last segment and flags it non-canonical', () => {
    expect(resolveNavPath(PAGES, ['b', 'b2'])).toMatchObject({ canonical: true, path: '/p/b/b2' });
    // b2 used to live at the top level — the old URL still finds it.
    expect(resolveNavPath(PAGES, ['b2'])).toMatchObject({ canonical: false, path: '/p/b/b2' });
    expect(resolveNavPath(PAGES, ['nope'])).toBeNull();
    expect(resolveNavPath(PAGES, [])).toBeNull();
  });
});

describe('computeDrop', () => {
  it('top half of a row drops before it, as a sibling', () => {
    expect(computeDrop(ROWS, rowOf('c'), 0.2, 'a')).toMatchObject({
      parentId: null,
      index: 1,
      edge: 'before',
      depth: 0,
    });
  });

  it('just below a row shows the indented line: drop as its child', () => {
    expect(computeDrop(ROWS, rowOf('a'), 0.6, 'c')).toMatchObject({
      parentId: 'a',
      index: 0,
      edge: 'after',
      depth: 1,
    });
  });

  it('a little lower shows the full-width line: drop as the next sibling', () => {
    expect(computeDrop(ROWS, rowOf('a'), 0.9, 'c')).toMatchObject({
      parentId: null,
      index: 1,
      edge: 'after',
      depth: 0,
    });
  });

  it('the bottom of an expanded parent always means "into it"', () => {
    expect(computeDrop(ROWS, rowOf('b'), 0.95, 'a')).toMatchObject({
      parentId: 'b',
      index: 0,
      depth: 1,
    });
  });

  it('works inside a nested group', () => {
    expect(computeDrop(ROWS, rowOf('b2'), 0.1, 'a')).toMatchObject({
      parentId: 'b',
      index: 1,
      depth: 1,
    });
  });

  it('refuses the dragged page and its own subtree', () => {
    expect(computeDrop(ROWS, rowOf('b'), 0.2, 'b')).toBeNull();
    expect(computeDrop(ROWS, rowOf('b1'), 0.2, 'b')).toBeNull();
  });

  it('counts sibling positions with the dragged page lifted out', () => {
    // Dragging a below c: before c is index 1 once a is removed (b, c).
    expect(computeDrop(ROWS, rowOf('c'), 0.2, 'a')?.index).toBe(1);
  });
});

describe('dropAtEnd / isNoopDrop', () => {
  it('drops at the end of the top level', () => {
    expect(dropAtEnd(ROWS, 'b1')).toMatchObject({
      parentId: null,
      index: 3,
      rowIndex: ROWS.length,
    });
    expect(dropAtEnd(ROWS, 'a')).toMatchObject({ index: 2 });
  });

  it('spots a drop that leaves the page where it is', () => {
    expect(isNoopDrop(ROWS, 'b', computeDrop(ROWS, rowOf('c'), 0.2, 'b')!)).toBe(true);
    expect(isNoopDrop(ROWS, 'b', computeDrop(ROWS, rowOf('a'), 0.2, 'b')!)).toBe(false);
  });
});
