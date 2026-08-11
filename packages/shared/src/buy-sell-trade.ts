// Buy/Sell/Trade widget (PD-437, epic PD-436). The gear list is the shared input for both
// jobs in the epic: the weekly r/modular scan matches against it (PD-438) and the monthly
// post drafter renders from it (PD-439).
//
// The list is GEAR, not modules. Eurorack is simply what Steve has most of right now; drum
// machines, synths and pedals sit on the same list, which is why the field is `item` and the
// categories include `Other Instruments`.

/**
 * What Steve wants to do with a piece of gear. Two values, not three.
 *
 * The sheet's `WTTF` ("want to trade for") list was originally imported as its own `WTT` type,
 * but it never earned the distinction: WTTF is gear Steve would *accept*, which makes it a
 * **want** — the same side of the ledger as WTB, differing only in how he'd pay. Carrying it as
 * a third type meant every consumer had to remember that two of three types were wants, which
 * is exactly the confusion that nearly drafted his want-list into a for-sale table.
 *
 * Retired 2026-08-04; existing `WTT` rows were migrated to `WTB` (`bst_retire_wtt_type`).
 * **Note the commenter side kept it** — see `BstMatchIntent`. A person in a BST thread really
 * can be offering a trade; Steve's own list is just no longer split that way.
 */
export const BST_LISTING_TYPES = ['WTB', 'WTS'] as const;
export type BstListingType = (typeof BST_LISTING_TYPES)[number];

export const BST_LISTING_TYPE_LABELS: Record<BstListingType, string> = {
  WTB: 'Want to buy',
  WTS: 'Want to sell',
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

/**
 * What kind of thing it is, within a sale status. Non-Eurorack gear sells to a different
 * audience, which is why the drafter sections a post by this.
 *
 * `Synths` and `Pedals` were carved out of `Other Instruments` (PD-475) because they are the two
 * kinds Steve actually owns and wants named. `Other Instruments` stays as the **residual
 * instrument** bucket — drum machines and the like — while `Misc` keeps its own meaning:
 * things that are not instruments at all (a MIDI splitter, a decoder).
 *
 * Purely additive; no existing row changes category. Order is display order.
 */
export const BST_CATEGORIES = [
  'Modules',
  'Synths',
  'Pedals',
  'Other Instruments',
  'Misc',
] as const;
export type BstCategory = (typeof BST_CATEGORIES)[number];

/**
 * One row of the gear list.
 *
 * `price` is TEXT, not a number, on purpose: a real gear list carries "$250 shipped",
 * "offers", "trade only" as often as a bare figure, and the import must not lose that.
 * The cost is that sorting by price is lexical — honest, if imperfect.
 *
 * `item` is the only required field because it is what the scanner matches comments on; a row
 * without one cannot do the widget's job. It is `item` rather than `module` on purpose — see
 * the note at the top of this file.
 *
 * **Duplicates are legal.** Steve owns two of some things, in different condition and at
 * different prices, and each is its own listing. There is deliberately no uniqueness constraint
 * in the database — see `findDuplicateListings`, which makes duplication a question the UI asks
 * rather than an error the DB raises.
 */
export interface BstListing {
  id: number;
  type: BstListingType;
  manufacturer: string | null;
  item: string;
  price: string | null;
  condition: string | null;
  /** Notes that GO IN THE POST — "og box", "purchased new". Public by definition. */
  notes: string | null;
  /**
   * Notes for Steve only. Never drafted into a post, never rendered on the collapsed card.
   * Exists so the public `notes` field can stay clean: "paid $310, don't go below $260" and
   * "og box, purchased new" are both worth recording and only one of them is for buyers.
   */
  privateNotes: string | null;
  /** "Current Location" in the sheet — private, like `privateNotes`. Shown to Steve when a post
   *  is generated so he can go and find the thing; never included in the post itself. */
  location: string | null;
  /** Willingness to sell. `null` on WTB rows, where it is meaningless. */
  saleStatus: BstSaleStatus | null;
  /** What kind of gear it is, within a sale status. `null` on WTB rows. */
  category: BstCategory | null;
  /**
   * Other names people use for this item, comma-separated (PD-475). Merged with the matcher's
   * curated defaults rather than replacing them.
   *
   * This exists because **Steve knows his gear and a hard-coded table in the matcher does not**:
   * only he knows that his `A-111-5 Mini Synth Voice` gets called "A-111-5" in a BST thread. A
   * curated table cannot scale to 52 listings, let alone stay correct as the list changes.
   *
   * Free text, one field, rather than a child table: it is edited by hand a few times a year and
   * a join would buy nothing.
   */
  aliases: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Split an `aliases` field into trimmed, non-empty alias strings. Commas separate; everything
 *  else is part of an alias, so "Pam's, PPW" yields two. */
export function parseAliases(aliases: string | null | undefined): string[] {
  if (!aliases) return [];
  return aliases
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}

export interface CreateBstListingInput {
  type: BstListingType;
  item: string;
  manufacturer?: string | null;
  price?: string | null;
  condition?: string | null;
  notes?: string | null;
  privateNotes?: string | null;
  location?: string | null;
  saleStatus?: BstSaleStatus | null;
  category?: BstCategory | null;
  aliases?: string | null;
}

/** Every field optional — an omitted field means "unchanged", never "clear it". */
export type UpdateBstListingInput = Partial<CreateBstListingInput>;

/* ── Drafted posts (PD-439, on-demand half built in PD-475) ────────────────────────────────── */

/**
 * The places Steve posts. Three formats of the same list, because each renders differently:
 * Reddit takes a markdown table, Facebook takes plain text (a markdown table renders as noise
 * there), and Discord takes markdown but has no tables.
 *
 * `discord` is new in PD-475 — the page subhead promises it, so the drafter has to produce it.
 * A subhead advertising an output nothing generates is worse than no subhead.
 */
export const BST_DRAFT_FORMATS = ['reddit', 'facebook', 'discord'] as const;
export type BstDraftFormat = (typeof BST_DRAFT_FORMATS)[number];

export const BST_DRAFT_FORMAT_LABELS: Record<BstDraftFormat, string> = {
  reddit: 'Reddit',
  facebook: 'Facebook',
  discord: 'Discord',
};

export function isBstDraftFormat(v: unknown): v is BstDraftFormat {
  return typeof v === 'string' && (BST_DRAFT_FORMATS as readonly string[]).includes(v);
}

/** One rendered post. History is kept — regenerating never overwrites an earlier draft, because
 *  the one you already pasted somewhere is a record of what you said. */
export interface BstDraft {
  id: number;
  format: BstDraftFormat;
  content: string;
  /** Shared by every draft in one generation, which is what groups them into a batch. */
  generatedAt: number;
}

/**
 * Tokens a template may use. Deliberately a small closed set rather than a templating engine —
 * these are posts, not programs, and a general engine is a much larger surface to secure and
 * explain for no gain.
 *
 * `{{items}}` and `{{feelers}}` are separate because they are different offers: `items` is
 * everything firmly for sale, `feelers` is gear he will part with for the right price. Merging
 * them would advertise 23 feelers as firm sales.
 */
export const BST_TEMPLATE_TOKENS = [
  '{{items}}',
  '{{feelers}}',
  '{{wanted}}',
  '{{terms}}',
  '{{month}}',
] as const;

/** Standing sale terms and the post templates (PD-439). Single row. */
export interface BstSettings {
  terms: string;
  /** One editable template per format, so the layout can be tuned without a deploy. */
  templates: Record<BstDraftFormat, string>;
  updatedAt: number;
}

/** Outcome of a CSV paste. `skipped` rows are reported with a reason rather than
 *  silently dropped — a half-imported list you believe is whole is worse than a failure. */
export interface BstImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** One human-readable line per skipped row, e.g. `row 4: missing Item`. */
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
  module: 'item',
  item: 'item',
  gear: 'item',
  price: 'price',
  condition: 'condition',
  notes: 'notes',
  'public notes': 'notes',
  'private notes': 'privateNotes',
  'current location': 'location',
  location: 'location',
  aliases: 'aliases',
  'also known as': 'aliases',
};

/**
 * Rejection body when a create/update would add a second listing for the same
 * (type, manufacturer, item). **Advisory, not an error condition** — two of the same module in
 * different condition at different prices is normal, so the server asks rather than refuses.
 * Re-send the same request with `confirmDuplicate: true` to go ahead.
 */
export interface BstDuplicateWarning {
  code: 'DUPLICATE_CONFIRM';
  error: string;
  /** The listings already on file, so the modal can show what they are before he confirms. */
  existing: BstListing[];
}

export function isBstListingType(v: unknown): v is BstListingType {
  return typeof v === 'string' && (BST_LISTING_TYPES as readonly string[]).includes(v);
}

export function isBstSaleStatus(v: unknown): v is BstSaleStatus {
  return typeof v === 'string' && (BST_SALE_STATUSES as readonly string[]).includes(v);
}

export function isBstCategory(v: unknown): v is BstCategory {
  return typeof v === 'string' && (BST_CATEGORIES as readonly string[]).includes(v);
}

/* ── Matches (PD-438) ───────────────────────────── */

/**
 * What the *commenter* wants to do — inferred from their own words, not from Steve's listing.
 *
 * `unknown` is a first-class outcome, not a failure. A BST comment that mentions an item with
 * no nearby WTS/WTB/WTT marker genuinely does not say which way it points, and recording a
 * guess would be worse than recording the uncertainty: Steve would open the thread expecting a
 * seller and find a buyer.
 */
export const BST_MATCH_INTENTS = ['WTS', 'WTB', 'WTT', 'unknown'] as const;
export type BstMatchIntent = (typeof BST_MATCH_INTENTS)[number];

export const BST_MATCH_INTENT_LABELS: Record<BstMatchIntent, string> = {
  WTS: 'Selling',
  WTB: 'Buying',
  WTT: 'Trading',
  unknown: 'Unclear',
};

/**
 * How sure the matcher is that this comment really means *this* listing (PD-475).
 *
 * `confirmed` — the name is distinctive on its own, or a generic name was corroborated by the
 * manufacturer in the same line item. `possible` — the only evidence is a generic name or a
 * machine-derived alias, so it is worth a two-second skim but not a claim.
 *
 * **Named `confirmed`/`possible` rather than PD-475's literal `high`/`low`** on purpose: a match
 * already carries `BstMatchSignificance`, whose values are `high`/`normal`/`low`. Two fields on
 * the same record, both reading `high`, meaning different things (how sure vs. how much it is
 * worth your attention) is a bug waiting to be written. These names also match what the UI
 * calls the group, "Possible matches".
 */
export const BST_MATCH_CONFIDENCES = ['confirmed', 'possible'] as const;
export type BstMatchConfidence = (typeof BST_MATCH_CONFIDENCES)[number];

export function isBstMatchConfidence(v: unknown): v is BstMatchConfidence {
  return typeof v === 'string' && (BST_MATCH_CONFIDENCES as readonly string[]).includes(v);
}

/** One comment that mentioned one listing. Joined with its listing for display. */
export interface BstMatch {
  id: number;
  listingId: number;
  /** Reddit thread id (`t3_xxxxx` or bare) — opaque here; the matcher never parses it. */
  threadId: string;
  commentId: string;
  /** Absolute URL to the comment. */
  permalink: string;
  author: string;
  /** `https://reddit.com/user/<author>` — stored rather than derived so a future source with a
   *  different profile URL scheme doesn't need a migration. */
  authorUrl: string;
  intent: BstMatchIntent;
  /** How sure the matcher is this is really the listing. Stored, not derived: it is a property
   *  of the evidence at scan time, and re-deriving it would need the comment body. */
  confidence: BstMatchConfidence;
  /** Which needle fired, for explaining a surprising match ("matched on: a 111 5"). Only
   *  worth showing on a `possible` match, where the answer is not self-evident. */
  matchedOn: string;
  /** A window of the comment around the mention — enough to judge without opening Reddit. */
  excerpt: string;
  matchedAt: number;
  dismissedAt: number | null;
  /* Denormalised from the listing, for display. */
  item: string;
  manufacturer: string | null;
  listingType: BstListingType;
  saleStatus: BstSaleStatus | null;
}

/**
 * How much a match is worth Steve's attention. Derived at read time, never stored: a listing's
 * `saleStatus` changes, and yesterday's feeler is today's firm sale.
 *
 * The high case is the one worth naming: a hit on a **WTB row** where the commenter is selling
 * or trading means someone is offering gear Steve is actively looking for. That is the most
 * valuable signal the scan produces, and it is easy to bury under sale-side noise.
 */
export type BstMatchSignificance = 'high' | 'normal' | 'low';

export function matchSignificance(
  listing: Pick<BstListing, 'type' | 'saleStatus'>,
  intent: BstMatchIntent,
): BstMatchSignificance {
  // Steve's wants: someone offering one of them is the payoff of the whole scan.
  if (!isSellable(listing.type)) {
    return intent === 'WTS' || intent === 'WTT' ? 'high' : 'normal';
  }
  // Steve's sales: a buyer for something he is firmly selling is worth surfacing.
  if (isFirmSale(listing) && (intent === 'WTB' || intent === 'WTT')) return 'high';
  // Gear he probably won't part with — real, but not worth interrupting him for.
  if (listing.saleStatus === 'probably-wont-sell') return 'low';
  return 'normal';
}

export function isBstMatchIntent(v: unknown): v is BstMatchIntent {
  return typeof v === 'string' && (BST_MATCH_INTENTS as readonly string[]).includes(v);
}

/** Outcome of running a thread's comments through the matcher. */
export interface BstIngestResult {
  /** Comments examined. */
  scanned: number;
  /** (listing, comment) pairs the matcher found. */
  matched: number;
  /** Rows actually written — `matched` minus anything already recorded. */
  created: number;
  /** Already-seen pairs. Non-zero on a re-scan is the *correct* result, not a problem. */
  duplicates: number;
}

/** What the matcher consumes. Deliberately not Reddit-shaped: PD-471 adapts to this, and a
 *  hand-pasted thread can too. */
export interface BstCommentInput {
  id: string;
  author: string;
  body: string;
  permalink: string;
}

/* ── Scans (PD-471, over public RSS) ───────────────────────────────────────────────────────── */

/**
 * How a scan ended.
 *
 * **`ok` and `failed` are not the only outcomes, and that is the point.** A scan that read one
 * thread and got rate-limited on the second saw *some* of the week's offers, and reporting that
 * as `ok` would be a lie of exactly the kind this feature cannot afford — "no offers this week"
 * and "Reddit refused the request" must never look alike.
 */
export const BST_SCAN_STATUSES = ['ok', 'partial', 'failed'] as const;
export type BstScanStatus = (typeof BST_SCAN_STATUSES)[number];

export interface BstScanThreadResult {
  title: string;
  url: string;
  /** Comments read from the feed. */
  scanned: number;
  /** (listing, comment) pairs the matcher found. */
  matched: number;
  /** Rows written — `matched` minus anything already recorded. */
  created: number;
  /** Present when this thread could not be read. The others may still have succeeded. */
  error: string | null;
}

/** The record of one scan. Persisted so a failure that happened at 3am is still visible at 9am —
 *  loudness that only exists in an HTTP response is not loudness for a scheduled job. */
export interface BstScan {
  id: number;
  startedAt: number;
  finishedAt: number;
  status: BstScanStatus;
  /** Set when the scan could not start at all (discovery failed) — distinct from a thread error. */
  error: string | null;
  threads: BstScanThreadResult[];
}

/** Did this scan see everything it was supposed to? The readout leads with this. */
export function scanIsComplete(scan: Pick<BstScan, 'status'>): boolean {
  return scan.status === 'ok';
}

/** What Steve is offering — the for-sale table of a drafted post (PD-439). WTB is a want and
 *  belongs in the post's wanted section instead. */
export function isSellable(type: BstListingType): boolean {
  return type === 'WTS';
}

/** Whether a listing should be drafted as a firm sale (PD-439): offered, and actually for
 *  sale rather than a feeler or something he probably won't part with. */
export function isFirmSale(listing: Pick<BstListing, 'type' | 'saleStatus'>): boolean {
  return isSellable(listing.type) && listing.saleStatus === 'for-sale';
}

/**
 * Where the things a post offers physically are, grouped for collecting them.
 *
 * **Never part of a post** — `location` is private (D-065). This exists so the drafter UI can
 * show it *beside* the draft: the post says what is for sale, this says where to go and find it.
 *
 * Lives in shared rather than next to the renderer because both sides want it and neither owns
 * it — the server renders posts, the web renders the pickup list, and one copy cannot drift.
 */
export function pickupList(listings: BstListing[]): { item: string; location: string }[] {
  return listings
    .filter((l) => isSellable(l.type) && l.saleStatus !== 'probably-wont-sell')
    .filter((l) => !!l.location?.trim())
    .map((l) => ({
      item: l.manufacturer ? `${l.manufacturer} ${l.item}` : l.item,
      location: l.location!.trim(),
    }))
    .sort((a, b) => a.location.localeCompare(b.location) || a.item.localeCompare(b.item));
}

/* ── Scheduled jobs (PD-439, PD-440) ─────────────────────────────────────────────────────────── */

/**
 * The `job_name` each BST cron records runs under in the shared `job_runs` store (PD-442).
 *
 * Shared because both sides need the exact string and a typo would fail silently as "this job
 * has never run" — indistinguishable from a job that genuinely hasn't. The server writes under
 * these names; the web registry and the widget's Runs panel read under them.
 */
export const BST_SCAN_JOB = 'buy-sell-trade:scan';
export const BST_DRAFTS_JOB = 'buy-sell-trade:drafts';

/**
 * The scan's headline numbers, as written into `JobRun.summary`.
 *
 * Flat and scalar on purpose: the generic run-detail page renders scalars as a definition list
 * without needing a custom renderer, and the per-thread breakdown already lives in the scan's own
 * `buy_sell_trade_scans` row, which is what the widget's loud readout reads.
 */
export interface BstScanRunSummary {
  threads: number;
  scanned: number;
  matched: number;
  created: number;
  threadsFailed: number;
  [key: string]: unknown;
}

/** The drafter's headline numbers, as written into `JobRun.summary`. */
export interface BstDraftsRunSummary {
  drafts: number;
  formats: string;
  [key: string]: unknown;
}

/* ── Ignored authors ─────────────────────────────────────────────────────────────────────────── */

/**
 * Reddit accounts whose comments never produce a match.
 *
 * Steve's own account is on here: his BST posts list the same gear as his listings, so **every
 * item he is selling matches his own comment**, which is pure noise and drowns the real offers.
 * The rule is "not interesting", not "not a match" — the matcher is right about the text, the
 * author is what makes it worthless.
 *
 * Lowercase, no `u/` prefix. Reddit usernames are case-insensitive for comparison purposes, so
 * `isIgnoredAuthor` normalises both sides rather than trusting the feed's casing.
 */
export const BST_IGNORED_AUTHORS: readonly string[] = ['holographicbboy'];

/** True if this comment's author should never generate matches. Tolerates `u/name` and casing. */
export function isIgnoredAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  const name = author.trim().replace(/^\/?u\//i, '').toLowerCase();
  return BST_IGNORED_AUTHORS.includes(name);
}
