import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createListing } from './store';

const BASE = '/api/widgets/buy-sell-trade';

function freshSetup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { app, db };
}

// The duplicate flow is a two-request conversation and it only exists at this layer — the store
// happily writes duplicates, by design. So it is tested here or nowhere.
describe('POST /listings — duplicates are confirmed, not refused', () => {
  it('creates without fuss when nothing matches', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ item: 'Maths', saleStatus: 'for-sale' });
  });

  it('asks for confirmation on a second copy, and says what is already there', async () => {
    const { app, db } = freshSetup();
    createListing(db, {
      type: 'WTS',
      item: 'Maths',
      manufacturer: 'Make Noise',
      condition: 'Mint',
      price: '$250',
    });

    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTS', item: 'maths', manufacturer: 'make noise', condition: 'Good' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; existing: { condition: string; price: string }[] };
    expect(body.code).toBe('DUPLICATE_CONFIRM');
    // The modal shows these so Steve can tell which one he already has.
    expect(body.existing).toHaveLength(1);
    expect(body.existing[0]).toMatchObject({ condition: 'Mint', price: '$250' });
  });

  it('goes through once confirmed — two of one item at different prices is the point', async () => {
    const { app, db } = freshSetup();
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise', price: '$250' });

    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: {
        type: 'WTS',
        item: 'Maths',
        manufacturer: 'Make Noise',
        price: '$180',
        confirmDuplicate: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: `${BASE}/listings` });
    expect(list.json() as unknown[]).toHaveLength(2);
  });

  it('does not confuse a want with a sale', async () => {
    const { app, db } = freshSetup();
    createListing(db, { type: 'WTB', item: 'Maths', manufacturer: 'Make Noise' });
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects WTT — the type was retired', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTT', item: 'Maths' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_TYPE');
  });

  it('round-trips private notes separately from public ones', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTS', item: 'Maths', notes: 'og box', privateNotes: 'paid $310' },
    });
    expect(res.json()).toMatchObject({ notes: 'og box', privateNotes: 'paid $310' });
  });

  it('accepts Other Instruments as a category', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/listings`,
      payload: { type: 'WTS', item: 'Digitakt', category: 'Other Instruments' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ category: 'Other Instruments' });
  });
});

describe('PATCH /listings/:id — duplicates', () => {
  it('never flags a row against itself', async () => {
    const { app, db } = freshSetup();
    const l = createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/listings/${l.id}`,
      payload: { item: 'Maths', price: '$240' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: '$240' });
  });

  it('asks when an edit renames a row onto another one', async () => {
    const { app, db } = freshSetup();
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    const other = createListing(db, { type: 'WTS', item: 'Plaits', manufacturer: 'Make Noise' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/listings/${other.id}`,
      payload: { item: 'Maths' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('DUPLICATE_CONFIRM');
  });

  it('does not ask when only price or condition changes', async () => {
    const { app, db } = freshSetup();
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    const dupe = createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/listings/${dupe.id}`,
      payload: { price: '$200' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('matches', () => {
  async function seeded() {
    const setup = freshSetup();
    createListing(setup.db, {
      type: 'WTS',
      item: 'Chronoblob',
      manufacturer: 'Alright Devices',
      saleStatus: 'for-sale',
    });
    await setup.app.inject({
      method: 'POST',
      url: `${BASE}/matches/ingest`,
      payload: {
        threadId: 't3_abc',
        comments: [
          {
            id: 'c1',
            author: 'seller_one',
            permalink: 'https://reddit.com/r/modular/comments/t/_/c1',
            body: 'WTS Chronoblob $250',
          },
        ],
      },
    });
    return setup;
  }

  it('ingests a hand-pasted thread — the fallback while API access is pending', async () => {
    const { app } = await seeded();
    const res = await app.inject({ method: 'GET', url: `${BASE}/matches` });
    const body = res.json() as { item: string; intent: string; authorUrl: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      item: 'Chronoblob',
      intent: 'WTS',
      authorUrl: 'https://reddit.com/user/seller_one',
    });
  });

  it('reports the count the collapsed card renders', async () => {
    const { app } = await seeded();
    const res = await app.inject({ method: 'GET', url: `${BASE}/matches/count` });
    expect(res.json()).toEqual({ open: 1 });
  });

  it('dismisses and un-dismisses', async () => {
    const { app } = await seeded();
    const [m] = (await app.inject({ method: 'GET', url: `${BASE}/matches` })).json() as {
      id: number;
    }[];

    const off = await app.inject({
      method: 'PATCH',
      url: `${BASE}/matches/${m.id}`,
      payload: { dismissed: true },
    });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/matches/count` })).json()).toEqual({
      open: 0,
    });

    // Still readable, just not in the to-read list.
    const all = await app.inject({ method: 'GET', url: `${BASE}/matches?includeDismissed=true` });
    expect(all.json() as unknown[]).toHaveLength(1);

    await app.inject({
      method: 'PATCH',
      url: `${BASE}/matches/${m.id}`,
      payload: { dismissed: false },
    });
    expect((await app.inject({ method: 'GET', url: `${BASE}/matches/count` })).json()).toEqual({
      open: 1,
    });
  });

  it('rejects an ingest with no threadId rather than filing matches under nothing', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/matches/ingest`,
      payload: { comments: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed comment instead of silently skipping it', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: `${BASE}/matches/ingest`,
      payload: { threadId: 't3_abc', comments: [{ author: 'x' }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/needs an id and a body/);
  });

  it('404s a dismiss for a match that does not exist', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/matches/9999`,
      payload: { dismissed: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
