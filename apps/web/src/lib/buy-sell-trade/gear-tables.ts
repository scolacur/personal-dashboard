import type {
  BstCategory,
  BstListing,
  BstListingType,
  BstSaleStatus,
  UpdateBstListingInput,
} from '@dashboard/shared';

/**
 * The gear list as four tables in willingness order (PD-475 B).
 *
 * **Why four tables rather than one sorted list.** Sale status sorts alphabetically, which puts
 * Feelers first and For Sale second — useless. The meaningful order is the willingness ladder,
 * and that is not alphabetical, so encoding it in the structure beats fighting the sort.
 *
 * **Why this lives here and not in ListManager.** `ListManager` has exactly one consumer — this
 * page — so a `groups` prop would be an API designed against a single imagined caller, which is
 * how `ListItem = Record<string, unknown>` shipped unusable. The component gained only neutral
 * primitives (draggable rows, a drop target); the meaning of a drop is here. Promote to a real
 * `groups` prop when PD-443 turns up a second list that wants grouping.
 */

export interface GearTable {
  key: string;
  /** The table's heading. There is deliberately no table called "Gear list" — the heading is
   *  the status, because that is the only thing distinguishing the four. */
  label: string;
  /** What a row lands as when dropped here, and what a row added here starts as. */
  patch: { type: BstListingType; saleStatus: BstSaleStatus | null };
  emptyText: string;
}

/** Order is the willingness ladder, most willing first. This array IS the ordering — there is no
 *  sort to get wrong. */
export const GEAR_TABLES: readonly GearTable[] = [
  {
    key: 'for-sale',
    label: 'For Sale',
    patch: { type: 'WTS', saleStatus: 'for-sale' },
    emptyText: 'Nothing firmly for sale.',
  },
  {
    key: 'feelers',
    label: 'Feelers',
    patch: { type: 'WTS', saleStatus: 'feelers' },
    emptyText: 'No feelers out.',
  },
  {
    key: 'probably-wont-sell',
    label: "Probably Won't Sell",
    patch: { type: 'WTS', saleStatus: 'probably-wont-sell' },
    emptyText: 'Nothing here.',
  },
  {
    key: 'wtb',
    label: 'WTB',
    patch: { type: 'WTB', saleStatus: null },
    emptyText: 'Nothing on the want list.',
  },
] as const;

/** The category a row gets when it moves out of WTB, where category is meaningless and therefore
 *  null. Modules because that is what most of the list is. */
export const DEFAULT_CATEGORY: BstCategory = 'Modules';

/**
 * Which table a listing belongs to.
 *
 * **Total by construction** — every listing lands somewhere, so no row can go missing from the
 * page just because its data is unusual. The fallthrough is For Sale: a WTS row with no sale
 * status recorded. The API never creates one (a hand-added WTS defaults to `for-sale`, the CSV
 * importer assigns a status), so this is a guard rather than a live case. Worth knowing if it
 * ever happens: the drafter's `isFirmSale` is stricter and would *not* draft such a row, so the
 * two would disagree — which is why a drop always writes the status explicitly.
 */
export function tableKeyFor(listing: Pick<BstListing, 'type' | 'saleStatus'>): string {
  if (listing.type === 'WTB') return 'wtb';
  if (listing.saleStatus === 'feelers') return 'feelers';
  if (listing.saleStatus === 'probably-wont-sell') return 'probably-wont-sell';
  return 'for-sale';
}

/** Split the list into the four tables, in ladder order. */
export function groupIntoTables(listings: BstListing[]): { table: GearTable; items: BstListing[] }[] {
  return GEAR_TABLES.map((table) => ({
    table,
    items: listings.filter((l) => tableKeyFor(l) === table.key),
  }));
}

/**
 * The patch that moves a listing into a table, or `null` if it is already there.
 *
 * Returning null for a no-op matters: dropping a row back where it came from should not issue a
 * write, bump `updated_at`, or trip the duplicate check.
 *
 * **Category is preserved across a move** — a pedal you stop wanting to sell is still a pedal.
 * The one exception is leaving WTB, where category is null because it is meaningless there; it
 * has to become something, and that something is `Modules`.
 */
export function movePatch(listing: BstListing, table: GearTable): UpdateBstListingInput | null {
  if (tableKeyFor(listing) === table.key) return null;

  const patch: UpdateBstListingInput = { ...table.patch };
  if (table.patch.type === 'WTB') {
    // Category and sale status are both meaningless on a want. Clearing category is what makes
    // the round trip WTS -> WTB -> WTS land on the default rather than on a stale value.
    patch.category = null;
  } else if (listing.category === null) {
    patch.category = DEFAULT_CATEGORY;
  }
  return patch;
}

/** What a listing created from inside a table starts as, so "+ Add" in Feelers does not make a
 *  For Sale row. */
export function createDefaults(table: GearTable): Record<string, string> {
  const out: Record<string, string> = { type: table.patch.type };
  if (table.patch.saleStatus) out.saleStatus = table.patch.saleStatus;
  if (table.patch.type !== 'WTB') out.category = DEFAULT_CATEGORY;
  return out;
}
