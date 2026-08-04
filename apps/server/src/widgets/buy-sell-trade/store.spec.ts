import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import {
  createListing,
  deleteListing,
  getSettings,
  importListingsCsv,
  listListings,
  updateListing,
  updateSettings,
} from './store';

const HEADER = 'Type,Manufacturer,Module,Price,Condition,Notes,Current Location';
const SHEET = [
  HEADER,
  'WTS,Make Noise,Maths,$250,Mint,boxed,Rack A',
  'WTS,Mutable,Plaits,$180,Good,,Rack B',
  'WTB,Intellijel,Quadrax,,,,',
].join('\n');

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  bootstrapSchema(db);
});

describe('listings CRUD', () => {
  it('creates and reads back a listing', () => {
    const l = createListing(db, { type: 'WTS', module: 'Maths', manufacturer: 'Make Noise' });
    expect(l).toMatchObject({ type: 'WTS', module: 'Maths', manufacturer: 'Make Noise' });
    expect(listListings(db)).toHaveLength(1);
  });

  it('defaults unspecified optional fields to null', () => {
    const l = createListing(db, { type: 'WTB', module: 'Quadrax' });
    expect(l).toMatchObject({ manufacturer: null, price: null, condition: null, notes: null, location: null });
  });

  it('leaves omitted fields unchanged on update', () => {
    const l = createListing(db, { type: 'WTS', module: 'Maths', price: '$250', notes: 'boxed' });
    const updated = updateListing(db, l.id, { price: '$225' });
    expect(updated).toMatchObject({ price: '$225', notes: 'boxed', module: 'Maths' });
  });

  it('clears a field when sent an explicit null', () => {
    const l = createListing(db, { type: 'WTS', module: 'Maths', notes: 'boxed' });
    expect(updateListing(db, l.id, { notes: null })?.notes).toBeNull();
  });

  it('returns null when updating a listing that does not exist', () => {
    expect(updateListing(db, 999, { price: '$1' })).toBeNull();
  });

  it('deletes', () => {
    const l = createListing(db, { type: 'WTS', module: 'Maths' });
    expect(deleteListing(db, l.id)).toBe(true);
    expect(deleteListing(db, l.id)).toBe(false);
    expect(listListings(db)).toEqual([]);
  });

  it('rejects a duplicate type+manufacturer+module, case-insensitively', () => {
    createListing(db, { type: 'WTS', module: 'Maths', manufacturer: 'Make Noise' });
    expect(() => createListing(db, { type: 'WTS', module: 'maths', manufacturer: 'make noise' })).toThrow(
      /UNIQUE/i,
    );
  });

  it('allows the same module under a different type — wanting and selling are distinct rows', () => {
    createListing(db, { type: 'WTS', module: 'Maths', manufacturer: 'Make Noise' });
    expect(() =>
      createListing(db, { type: 'WTB', module: 'Maths', manufacturer: 'Make Noise' }),
    ).not.toThrow();
  });
});

describe('importListingsCsv', () => {
  it('imports the sheet', () => {
    const r = importListingsCsv(db, SHEET);
    expect(r).toMatchObject({ created: 3, updated: 0, skipped: 0 });
    expect(listListings(db)).toHaveLength(3);
  });

  // The ticket's acceptance criterion: pasting twice must not duplicate.
  it('is idempotent — re-pasting the same export updates instead of duplicating', () => {
    importListingsCsv(db, SHEET);
    const second = importListingsCsv(db, SHEET);
    expect(second).toMatchObject({ created: 0, updated: 3 });
    expect(listListings(db)).toHaveLength(3);
  });

  it('corrects a changed field on re-import rather than adding a row', () => {
    importListingsCsv(db, SHEET);
    importListingsCsv(db, SHEET.replace('$250', '$210'));
    const maths = listListings(db).find((l) => l.module === 'Maths');
    expect(maths?.price).toBe('$210');
    expect(listListings(db)).toHaveLength(3);
  });

  it('matches existing rows case-insensitively, so tidied casing does not duplicate', () => {
    importListingsCsv(db, SHEET);
    const retyped = importListingsCsv(db, `${HEADER}\nwts,make noise,maths,$250,Mint,boxed,Rack A`);
    expect(retyped).toMatchObject({ created: 0, updated: 1 });
    expect(listListings(db)).toHaveLength(3);
  });

  it('reports skipped rows without losing the good ones', () => {
    const r = importListingsCsv(db, `${HEADER}\nWTS,Make Noise,Maths,,,,\nSOLD,X,Y,,,,`);
    expect(r).toMatchObject({ created: 1, skipped: 1 });
    expect(r.problems[0]).toMatch(/row 3/);
    expect(listListings(db)).toHaveLength(1);
  });

  it('leaves the list untouched when the CSV has no usable header', () => {
    importListingsCsv(db, SHEET);
    const r = importListingsCsv(db, 'Foo,Bar\n1,2');
    expect(r).toMatchObject({ created: 0, updated: 0 });
    expect(listListings(db)).toHaveLength(3);
  });
});

describe('settings', () => {
  it('starts with empty terms rather than no row', () => {
    expect(getSettings(db).terms).toBe('');
  });

  it('round-trips terms', () => {
    updateSettings(db, 'Shipping is on the buyer.');
    expect(getSettings(db).terms).toBe('Shipping is on the buyer.');
  });

  it('overwrites rather than accumulating rows', () => {
    updateSettings(db, 'first');
    updateSettings(db, 'second');
    expect(getSettings(db).terms).toBe('second');
    const count = db.prepare('SELECT COUNT(*) AS n FROM buy_sell_trade_settings').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
