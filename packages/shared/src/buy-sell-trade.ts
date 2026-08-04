// Buy/Sell/Trade widget (PD-437, epic PD-436). The gear list is the shared input for both
// jobs in the epic: the weekly r/modular scan matches against it (PD-438) and the monthly
// post drafter renders from it (PD-439).

/** What Steve wants to do with a module. Mirrors the "Type" column of the source sheet. */
export const BST_LISTING_TYPES = ['WTB', 'WTS', 'WTT'] as const;
export type BstListingType = (typeof BST_LISTING_TYPES)[number];

export const BST_LISTING_TYPE_LABELS: Record<BstListingType, string> = {
  WTB: 'Want to buy',
  WTS: 'Want to sell',
  WTT: 'Want to trade',
};

/**
 * One row of the WTB/WTS/WTT list.
 *
 * `price` is TEXT, not a number, on purpose: a real gear list carries "$250 shipped",
 * "offers", "trade only" as often as a bare figure, and the import must not lose that.
 * The cost is that sorting by price is lexical — honest, if imperfect.
 *
 * `module` is the only required field because it is what the scanner matches comments on;
 * a row without one cannot do the widget's job.
 */
export interface BstListing {
  id: number;
  type: BstListingType;
  manufacturer: string | null;
  module: string;
  price: string | null;
  condition: string | null;
  notes: string | null;
  /** "Current Location" in the sheet — Steve's own reference, not shown in drafts. */
  location: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBstListingInput {
  type: BstListingType;
  module: string;
  manufacturer?: string | null;
  price?: string | null;
  condition?: string | null;
  notes?: string | null;
  location?: string | null;
}

/** Every field optional — an omitted field means "unchanged", never "clear it". */
export type UpdateBstListingInput = Partial<CreateBstListingInput>;

/** Standing sale terms, appended to the drafted posts (PD-439). Single row. */
export interface BstSettings {
  terms: string;
  updatedAt: number;
}

/** Outcome of a CSV paste. `skipped` rows are reported with a reason rather than
 *  silently dropped — a half-imported list you believe is whole is worse than a failure. */
export interface BstImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** One human-readable line per skipped row, e.g. `row 4: missing Module`. */
  problems: string[];
}

/** Column headers accepted by the CSV importer, mapped to listing fields. Matches the
 *  source sheet's headers verbatim (including "Current Location"); matching is
 *  case-insensitive and whitespace-tolerant, so a re-export with tidier casing still works. */
export const BST_CSV_COLUMNS: Record<string, keyof CreateBstListingInput> = {
  type: 'type',
  manufacturer: 'manufacturer',
  module: 'module',
  price: 'price',
  condition: 'condition',
  notes: 'notes',
  'current location': 'location',
  location: 'location',
};

export function isBstListingType(v: unknown): v is BstListingType {
  return typeof v === 'string' && (BST_LISTING_TYPES as readonly string[]).includes(v);
}

/** Sellable types — what goes in the for-sale table of a drafted post. WTB is what Steve is
 *  *looking for*, so it belongs in its own section (PD-439). */
export function isSellable(type: BstListingType): boolean {
  return type === 'WTS' || type === 'WTT';
}
