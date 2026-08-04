// Buy/Sell/Trade widget (PD-437, epic PD-436). The gear list is the shared input for both
// jobs in the epic: the weekly r/modular scan matches against it (PD-438) and the monthly
// post drafter renders from it (PD-439).

/** What Steve wants to do with a module. Mirrors the "Type" column of the source sheet. */
export const BST_LISTING_TYPES = ['WTB', 'WTS', 'WTT'] as const;
export type BstListingType = (typeof BST_LISTING_TYPES)[number];

export const BST_LISTING_TYPE_LABELS: Record<BstListingType, string> = {
  WTB: 'Want to buy',
  WTS: 'Want to sell',
  // "Want to trade FOR" — the WTTF list is gear Steve would ACCEPT in trade, not gear he is
  // offering. That direction is why `isSellable` is WTS-only.
  WTT: 'Want to trade for',
};

/**
 * Willingness to part with a listing — the top level of the taxonomy. The source sheet
 * expressed this as running section markers in one column (`MODULES` / `MISC` / `Feelers` /
 * `Probably won't sell`), mixing willingness with category; this splits the two.
 *
 * Load-bearing for PD-439: only `for-sale` belongs in a drafted post as a firm sale.
 */
export const BST_SALE_STATUSES = ['for-sale', 'feelers', 'probably-wont-sell'] as const;
export type BstSaleStatus = (typeof BST_SALE_STATUSES)[number];

export const BST_SALE_STATUS_LABELS: Record<BstSaleStatus, string> = {
  'for-sale': 'For Sale',
  feelers: 'Feelers',
  'probably-wont-sell': "Probably Won't Sell",
};

/** What kind of thing it is, within a sale status. */
export const BST_CATEGORIES = ['Modules', 'Misc'] as const;
export type BstCategory = (typeof BST_CATEGORIES)[number];

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
  /** Willingness to sell. `null` on want rows (WTB/WTT), where it is meaningless. */
  saleStatus: BstSaleStatus | null;
  /** Modules vs Misc, within a sale status. `null` on want rows. */
  category: BstCategory | null;
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
  saleStatus?: BstSaleStatus | null;
  category?: BstCategory | null;
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
  /**
   * Sale terms found in the sheet's first column, above the WTTF marker. **Offered, never
   * applied** — the import returns it for the UI to show with an "use these" action, so a
   * re-import can't silently overwrite terms that have since been edited in the app.
   */
  extractedTerms: string | null;
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

export function isBstSaleStatus(v: unknown): v is BstSaleStatus {
  return typeof v === 'string' && (BST_SALE_STATUSES as readonly string[]).includes(v);
}

export function isBstCategory(v: unknown): v is BstCategory {
  return typeof v === 'string' && (BST_CATEGORIES as readonly string[]).includes(v);
}

/** What Steve is offering — the for-sale table of a drafted post (PD-439).
 *
 *  **WTS only.** WTB and WTT are both *wants*: WTT is "want to trade FOR", gear he would
 *  accept in trade, not gear he is offering. They belong in the post's wanted section. */
export function isSellable(type: BstListingType): boolean {
  return type === 'WTS';
}

/** Whether a listing should be drafted as a firm sale (PD-439): offered, and actually for
 *  sale rather than a feeler or something he probably won't part with. */
export function isFirmSale(listing: Pick<BstListing, 'type' | 'saleStatus'>): boolean {
  return isSellable(listing.type) && listing.saleStatus === 'for-sale';
}
