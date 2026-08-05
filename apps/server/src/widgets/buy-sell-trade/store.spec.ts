import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import {
  countOpenMatches,
  createListing,
  deleteListing,
  findDuplicateListings,
  getSettings,
  importListingsCsv,
  ingestComments,
  listListings,
  listMatches,
  setMatchDismissed,
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
  // db.ts sets this on the real database; the fixture matches it so the matches table's
  // ON DELETE CASCADE actually fires here rather than silently doing nothing in tests only.
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
});

describe('listings CRUD', () => {
  it('creates and reads back a listing', () => {
    const l = createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    expect(l).toMatchObject({ type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    expect(listListings(db)).toHaveLength(1);
  });

  it('defaults unspecified optional fields to null', () => {
    const l = createListing(db, { type: 'WTB', item: 'Quadrax' });
    expect(l).toMatchObject({ manufacturer: null, price: null, condition: null, notes: null, location: null });
  });

  it('leaves omitted fields unchanged on update', () => {
    const l = createListing(db, { type: 'WTS', item: 'Maths', price: '$250', notes: 'boxed' });
    const updated = updateListing(db, l.id, { price: '$225' });
    expect(updated).toMatchObject({ price: '$225', notes: 'boxed', item: 'Maths' });
  });

  it('clears a field when sent an explicit null', () => {
    const l = createListing(db, { type: 'WTS', item: 'Maths', notes: 'boxed' });
    expect(updateListing(db, l.id, { notes: null })?.notes).toBeNull();
  });

  it('returns null when updating a listing that does not exist', () => {
    expect(updateListing(db, 999, { price: '$1' })).toBeNull();
  });

  it('deletes', () => {
    const l = createListing(db, { type: 'WTS', item: 'Maths' });
    expect(deleteListing(db, l.id)).toBe(true);
    expect(deleteListing(db, l.id)).toBe(false);
    expect(listListings(db)).toEqual([]);
  });

  // PD-437 shipped a UNIQUE index here and it was wrong about the domain: Steve owns two of
  // some things, in different condition, at different prices. The database no longer objects;
  // duplication is a question the UI asks (see findDuplicateListings).
  it('allows a second listing for the same thing — two of one item is real', () => {
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise', condition: 'Mint' });
    expect(() =>
      createListing(db, { type: 'WTS', item: 'maths', manufacturer: 'make noise', condition: 'Good' }),
    ).not.toThrow();
    expect(listListings(db)).toHaveLength(2);
  });

  it('allows the same item under a different type — wanting and selling are distinct rows', () => {
    createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    expect(() =>
      createListing(db, { type: 'WTB', item: 'Maths', manufacturer: 'Make Noise' }),
    ).not.toThrow();
  });
});

describe('findDuplicateListings', () => {
  it('finds same type+manufacturer+item case-insensitively, ignoring condition and price', () => {
    const a = createListing(db, {
      type: 'WTS',
      item: 'Maths',
      manufacturer: 'Make Noise',
      condition: 'Mint',
      price: '$250',
    });
    const hits = findDuplicateListings(db, {
      type: 'WTS',
      manufacturer: 'make noise',
      item: 'maths',
    });
    expect(hits.map((h) => h.id)).toEqual([a.id]);
  });

  it('does not flag a different type — wanting one is not owning one', () => {
    createListing(db, { type: 'WTB', item: 'Maths', manufacturer: 'Make Noise' });
    expect(findDuplicateListings(db, { type: 'WTS', manufacturer: 'Make Noise', item: 'Maths' })).toEqual(
      [],
    );
  });

  it('treats a missing manufacturer as distinct from a named one', () => {
    createListing(db, { type: 'WTS', item: 'Maths' });
    expect(findDuplicateListings(db, { type: 'WTS', manufacturer: 'Make Noise', item: 'Maths' })).toEqual(
      [],
    );
    expect(findDuplicateListings(db, { type: 'WTS', item: 'Maths' })).toHaveLength(1);
  });

  it('excludes the row being edited, so an edit never flags itself', () => {
    const l = createListing(db, { type: 'WTS', item: 'Maths', manufacturer: 'Make Noise' });
    expect(
      findDuplicateListings(db, { type: 'WTS', manufacturer: 'Make Noise', item: 'Maths' }, l.id),
    ).toEqual([]);
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
    const maths = listListings(db).find((l) => l.item === 'Maths');
    expect(maths?.price).toBe('$210');
    expect(listListings(db)).toHaveLength(3);
  });

  it('matches existing rows case-insensitively, so tidied casing does not duplicate', () => {
    importListingsCsv(db, SHEET);
    const retyped = importListingsCsv(db, `${HEADER}\nwts,make noise,maths,$250,Mint,boxed,Rack A`);
    expect(retyped).toMatchObject({ created: 0, updated: 1 });
    expect(listListings(db)).toHaveLength(3);
  });

  // An unrecognised Type is a SECTION marker in this sheet, not a bad row — the sheet's
  // second column carries MODULES / MISC / Feelers / "Probably won't sell".
  it('treats an unrecognised Type as a section rather than rejecting the row', () => {
    const r = importListingsCsv(db, `${HEADER}\nWTS,Make Noise,Maths,,,,\nFeelers,X,Y,,,,`);
    expect(r).toMatchObject({ created: 2, skipped: 0 });
    const y = listListings(db).find((l) => l.item === 'Y');
    expect(y).toMatchObject({ type: 'WTS', saleStatus: 'feelers', category: 'Modules' });
  });

  it('carries a changed sale status through an update on re-import', () => {
    importListingsCsv(db, `${HEADER}\nFeelers,ALM,mmMidi,$100,,,`);
    importListingsCsv(db, `${HEADER}\nProbably won't sell,ALM,mmMidi,$100,,,`);
    const m = listListings(db).find((l) => l.item === 'mmMidi');
    expect(m?.saleStatus).toBe('probably-wont-sell');
    expect(listListings(db)).toHaveLength(1);
  });

  it('offers terms found in the sheet without applying them', () => {
    const sheet = [
      "Holographic b_boys's Module FS List,Type,Manufacturer,Module,Price,Condition,Notes,Current Location",
      'like new condition,,SSF,Ultra Perc,$380,Excellent,,',
      'WTTF:,,,,,,,',
      'acidlab m303,,,,,,,',
    ].join('\n');
    const r = importListingsCsv(db, sheet);
    expect(r.extractedTerms).toBe('like new condition');
    // Offered, not applied — a re-import must never clobber terms edited in the app.
    expect(getSettings(db).terms).toBe('');
    expect(listListings(db).map((l) => l.item).sort()).toEqual(['Ultra Perc', 'acidlab m303']);
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

/* ── Matches (PD-438) ───────────────────────────── */

const COMMENTS = [
  {
    id: 'c1',
    author: 'seller_one',
    permalink: 'https://reddit.com/r/modular/comments/t/_/c1',
    body: 'WTS: Chronoblob $250, mint with box',
  },
  {
    id: 'c2',
    author: 'buyer_two',
    permalink: 'https://reddit.com/r/modular/comments/t/_/c2',
    body: 'WTB: Quadrax, will pay well',
  },
];

// saleStatus is set explicitly: defaulting it is the route's job, not the store's.
function seedForMatching(): void {
  createListing(db, {
    type: 'WTS',
    item: 'Chronoblob',
    manufacturer: 'Alright Devices',
    saleStatus: 'for-sale',
  });
  createListing(db, { type: 'WTB', item: 'Quadrax', manufacturer: 'Intellijel' });
}

describe('ingestComments', () => {
  beforeEach(seedForMatching);

  it('records what the matcher found, joined with its listing for display', () => {
    const r = ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
    expect(r).toEqual({ scanned: 2, matched: 2, created: 2, duplicates: 0 });

    const matches = listMatches(db);
    expect(matches.map((m) => m.item).sort()).toEqual(['Chronoblob', 'Quadrax']);
    const blob = matches.find((m) => m.item === 'Chronoblob')!;
    expect(blob).toMatchObject({
      threadId: 't3_abc',
      commentId: 'c1',
      author: 'seller_one',
      authorUrl: 'https://reddit.com/user/seller_one',
      intent: 'WTS',
      listingType: 'WTS',
      saleStatus: 'for-sale',
      dismissedAt: null,
    });
    expect(blob.excerpt).toContain('$250');
  });

  // The property the whole weekly job depends on. Without it the readout would refill with the
  // same matches every Sunday.
  it('re-scanning the same thread creates nothing new', () => {
    ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
    const second = ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
    expect(second).toEqual({ scanned: 2, matched: 2, created: 0, duplicates: 2 });
    expect(listMatches(db)).toHaveLength(2);
  });

  // The subtler half of the same property: a dismissed match must not come back to life with a
  // null dismissed_at, or the dismiss button is useless every time the job runs.
  it('does not resurrect a dismissed match on re-scan', () => {
    ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
    const [first] = listMatches(db);
    setMatchDismissed(db, first.id, true);
    expect(countOpenMatches(db)).toBe(1);

    ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
    expect(countOpenMatches(db)).toBe(1);
    expect(listMatches(db, true)).toHaveLength(2);
  });

  it('reports a scan that matched nothing without writing anything', () => {
    const r = ingestComments(db, {
      threadId: 't3_abc',
      comments: [{ id: 'c9', author: 'x', permalink: 'p', body: 'anyone selling a Rings?' }],
    });
    expect(r).toEqual({ scanned: 1, matched: 0, created: 0, duplicates: 0 });
    expect(listMatches(db)).toEqual([]);
  });
});

describe('matches readout', () => {
  beforeEach(() => {
    seedForMatching();
    ingestComments(db, { threadId: 't3_abc', comments: COMMENTS });
  });

  it('hides dismissed matches by default and returns them on request', () => {
    const [first] = listMatches(db);
    expect(setMatchDismissed(db, first.id, true)?.dismissedAt).toBeTypeOf('number');
    expect(listMatches(db)).toHaveLength(1);
    expect(listMatches(db, true)).toHaveLength(2);
  });

  it('un-dismisses', () => {
    const [first] = listMatches(db);
    setMatchDismissed(db, first.id, true);
    expect(setMatchDismissed(db, first.id, false)?.dismissedAt).toBeNull();
    expect(countOpenMatches(db)).toBe(2);
  });

  it('returns null for a match that does not exist', () => {
    expect(setMatchDismissed(db, 9999, true)).toBeNull();
  });

  it('drops a listing’s matches with the listing — an orphan match has nothing to show', () => {
    const [first] = listMatches(db);
    deleteListing(db, first.listingId);
    expect(listMatches(db, true).some((m) => m.listingId === first.listingId)).toBe(false);
  });
});
