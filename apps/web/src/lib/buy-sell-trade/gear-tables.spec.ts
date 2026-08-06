import { describe, expect, it } from 'vitest';
import type { BstListing } from '@dashboard/shared';
import {
  GEAR_TABLES,
  createDefaults,
  groupIntoTables,
  movePatch,
  tableKeyFor,
} from './gear-tables';

let nextId = 1;
function listing(over: Partial<BstListing> = {}): BstListing {
  return {
    id: nextId++,
    type: 'WTS',
    manufacturer: null,
    item: 'Thing',
    price: null,
    condition: null,
    notes: null,
    privateNotes: null,
    location: null,
    saleStatus: 'for-sale',
    category: 'Modules',
    aliases: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const table = (key: string) => GEAR_TABLES.find((t) => t.key === key)!;

describe('GEAR_TABLES', () => {
  // The whole point of splitting the table: sale status sorts alphabetically, which is not the
  // order that means anything. This array is the ordering.
  it('is the willingness ladder, most willing first', () => {
    expect(GEAR_TABLES.map((t) => t.label)).toEqual([
      'For Sale',
      'Feelers',
      "Probably Won't Sell",
      'WTB',
    ]);
  });
});

describe('tableKeyFor', () => {
  it('routes each sale status to its own table', () => {
    expect(tableKeyFor(listing({ saleStatus: 'for-sale' }))).toBe('for-sale');
    expect(tableKeyFor(listing({ saleStatus: 'feelers' }))).toBe('feelers');
    expect(tableKeyFor(listing({ saleStatus: 'probably-wont-sell' }))).toBe('probably-wont-sell');
  });

  it('routes a want to WTB whatever its sale status says', () => {
    expect(tableKeyFor(listing({ type: 'WTB', saleStatus: null }))).toBe('wtb');
    expect(tableKeyFor(listing({ type: 'WTB', saleStatus: 'feelers' }))).toBe('wtb');
  });

  // Total by construction: a row with unusual data must still appear somewhere, or it silently
  // vanishes from the page.
  it('never drops a row — a WTS with no sale status falls through to For Sale', () => {
    expect(tableKeyFor(listing({ type: 'WTS', saleStatus: null }))).toBe('for-sale');
  });
});

describe('groupIntoTables', () => {
  it('returns all four tables in order, even the empty ones', () => {
    const out = groupIntoTables([listing({ saleStatus: 'feelers' })]);
    expect(out.map((g) => g.table.key)).toEqual(GEAR_TABLES.map((t) => t.key));
    expect(out.map((g) => g.items.length)).toEqual([0, 1, 0, 0]);
  });

  it('partitions without losing or duplicating a row', () => {
    const rows = [
      listing({ saleStatus: 'for-sale' }),
      listing({ saleStatus: 'feelers' }),
      listing({ saleStatus: 'probably-wont-sell' }),
      listing({ type: 'WTB', saleStatus: null, category: null }),
    ];
    const out = groupIntoTables(rows);
    expect(out.flatMap((g) => g.items.map((i) => i.id)).sort()).toEqual(rows.map((r) => r.id).sort());
  });
});

describe('movePatch', () => {
  it('sets type and sale status for the destination', () => {
    expect(movePatch(listing({ saleStatus: 'for-sale' }), table('feelers'))).toEqual({
      type: 'WTS',
      saleStatus: 'feelers',
    });
  });

  // Dropping a row back where it came from should not write, bump updated_at, or trip the
  // duplicate check.
  it('is null when the row is already in that table', () => {
    expect(movePatch(listing({ saleStatus: 'feelers' }), table('feelers'))).toBeNull();
    expect(movePatch(listing({ type: 'WTB', saleStatus: null }), table('wtb'))).toBeNull();
  });

  it('preserves category across a move — a pedal you stop selling is still a pedal', () => {
    const patch = movePatch(
      listing({ category: 'Pedals', saleStatus: 'for-sale' }),
      table('probably-wont-sell'),
    );
    expect(patch).not.toHaveProperty('category');
  });

  it('clears category on the way into WTB, where it is meaningless', () => {
    expect(movePatch(listing({ category: 'Pedals' }), table('wtb'))).toEqual({
      type: 'WTB',
      saleStatus: null,
      category: null,
    });
  });

  it('gives a row leaving WTB a category, since it has none', () => {
    const patch = movePatch(
      listing({ type: 'WTB', saleStatus: null, category: null }),
      table('feelers'),
    );
    expect(patch).toEqual({ type: 'WTS', saleStatus: 'feelers', category: 'Modules' });
  });

  it('round-trips WTS -> WTB -> WTS onto the default rather than a stale category', () => {
    const wts = listing({ category: 'Synths', saleStatus: 'for-sale' });
    const toWtb = movePatch(wts, table('wtb'))!;
    const parked = { ...wts, ...toWtb } as BstListing;
    expect(movePatch(parked, table('for-sale'))).toEqual({
      type: 'WTS',
      saleStatus: 'for-sale',
      category: 'Modules',
    });
  });
});

describe('createDefaults', () => {
  it('makes "+ Add" inside a table create a row that belongs to it', () => {
    expect(createDefaults(table('feelers'))).toEqual({
      type: 'WTS',
      saleStatus: 'feelers',
      category: 'Modules',
    });
  });

  it('leaves a want without a sale status or category', () => {
    expect(createDefaults(table('wtb'))).toEqual({ type: 'WTB' });
  });
});
