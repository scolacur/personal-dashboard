import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import type { NavPage } from '@dashboard/shared';
import { bootstrapShellPagesSchema, getNavPages, patchNavPage } from './shell-pages';
import { registerShellPagesRoutes } from './shell-pages-routes';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapShellPagesSchema(db);
  app = Fastify({ logger: false });
  registerShellPagesRoutes(app, db);
});

const ids = (pages: NavPage[], parentId: string | null = null) =>
  pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);

describe('bootstrapShellPagesSchema', () => {
  it('seeds the seven code-defined pages, top-level, in their old order', () => {
    expect(ids(getNavPages(db))).toEqual([
      'productivity',
      'health-fitness',
      'music-discovery',
      'music-production',
      'event-tracker',
      'buy-sell-trade',
      'inboxes',
    ]);
  });

  it('never seeds the pinned built-ins', () => {
    const all = getNavPages(db).map((p) => p.id);
    expect(all).not.toContain('home');
    expect(all).not.toContain('devops');
  });

  it('keeps slugs equal to the old route segments, so old URLs can redirect', () => {
    for (const p of getNavPages(db)) expect(p.slug).toBe(p.id);
  });

  it('is idempotent and does not reset a moved page on a later boot', () => {
    patchNavPage(db, 'inboxes', { parentId: 'productivity', order: 0 });
    bootstrapShellPagesSchema(db);
    expect(getNavPages(db).find((p) => p.id === 'inboxes')?.parentId).toBe('productivity');
    expect(getNavPages(db)).toHaveLength(7);
  });
});

describe('patchNavPage', () => {
  it('reorders within the top level', () => {
    const r = patchNavPage(db, 'inboxes', { order: 0 });
    if ('error' in r) throw new Error(r.error);
    expect(ids(r.pages).slice(0, 2)).toEqual(['inboxes', 'productivity']);
  });

  it('nests a page and closes the gap it left', () => {
    const r = patchNavPage(db, 'health-fitness', { parentId: 'productivity', order: 0 });
    if ('error' in r) throw new Error(r.error);
    expect(ids(r.pages, 'productivity')).toEqual(['health-fitness']);
    expect(
      r.pages
        .filter((p) => p.parentId === null)
        .map((p) => p.order)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('carries children with their parent', () => {
    patchNavPage(db, 'health-fitness', { parentId: 'productivity', order: 0 });
    const r = patchNavPage(db, 'productivity', { parentId: 'inboxes', order: 0 });
    if ('error' in r) throw new Error(r.error);
    expect(ids(r.pages, 'inboxes')).toEqual(['productivity']);
    expect(ids(r.pages, 'productivity')).toEqual(['health-fitness']);
  });

  it('refuses a cycle', () => {
    patchNavPage(db, 'health-fitness', { parentId: 'productivity', order: 0 });
    expect(patchNavPage(db, 'productivity', { parentId: 'health-fitness', order: 0 })).toEqual({
      error: 'CYCLE',
    });
    expect(patchNavPage(db, 'productivity', { parentId: 'productivity', order: 0 })).toEqual({
      error: 'CYCLE',
    });
  });

  it('refuses to move a pinned page or nest under one', () => {
    expect(patchNavPage(db, 'home', { order: 3 })).toEqual({ error: 'PINNED' });
    expect(patchNavPage(db, 'devops', { order: 0 })).toEqual({ error: 'PINNED' });
    expect(patchNavPage(db, 'inboxes', { parentId: 'devops', order: 0 })).toEqual({
      error: 'PINNED',
    });
  });

  it('renames, trimming, and refuses an empty title', () => {
    const r = patchNavPage(db, 'inboxes', { title: '  Chores ' });
    if ('error' in r) throw new Error(r.error);
    expect(r.pages.find((p) => p.id === 'inboxes')?.title).toBe('Chores');
    expect(patchNavPage(db, 'inboxes', { title: '   ' })).toEqual({ error: 'INVALID_TITLE' });
  });
});

describe('routes', () => {
  it('GET lists the pages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/shell/nav-pages' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as NavPage[]).length).toBe(7);
  });

  it('PATCH moves a page and returns the whole list', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/shell/nav-pages/inboxes',
      payload: { parentId: 'productivity', order: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(ids(res.json() as NavPage[], 'productivity')).toEqual(['inboxes']);
  });

  it('PATCH maps errors to statuses', async () => {
    const notFound = await app.inject({
      method: 'PATCH',
      url: '/api/shell/nav-pages/nope',
      payload: { order: 0 },
    });
    expect(notFound.statusCode).toBe(404);
    const pinned = await app.inject({
      method: 'PATCH',
      url: '/api/shell/nav-pages/home',
      payload: { order: 0 },
    });
    expect(pinned.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/shell/nav-pages/inboxes',
      payload: { order: -1 },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/shell/nav-pages/inboxes',
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});
