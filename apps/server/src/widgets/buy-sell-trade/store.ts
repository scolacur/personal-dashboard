import type Database from 'better-sqlite3';
import type {
  BstCategory,
  BstCommentInput,
  BstImportResult,
  BstIngestResult,
  BstListing,
  BstListingType,
  BstMatch,
  BstMatchIntent,
  BstSaleStatus,
  BstSettings,
  CreateBstListingInput,
  UpdateBstListingInput,
} from '@dashboard/shared';
import { parseSheetCsv } from './csv';
import { matchComments } from './matcher';

interface ListingRow {
  id: number;
  type: string;
  manufacturer: string | null;
  item: string;
  price: string | null;
  condition: string | null;
  notes: string | null;
  private_notes: string | null;
  location: string | null;
  sale_status: string | null;
  category: string | null;
  created_at: number;
  updated_at: number;
}

function rowToListing(r: ListingRow): BstListing {
  return {
    id: r.id,
    type: r.type as BstListingType,
    manufacturer: r.manufacturer,
    item: r.item,
    price: r.price,
    condition: r.condition,
    notes: r.notes,
    privateNotes: r.private_notes,
    location: r.location,
    saleStatus: r.sale_status as BstSaleStatus | null,
    category: r.category as BstCategory | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ── Listings ───────────────────────────────────── */

export function listListings(db: Database.Database): BstListing[] {
  const rows = db
    .prepare('SELECT * FROM buy_sell_trade_listings ORDER BY type, item COLLATE NOCASE')
    .all() as ListingRow[];
  return rows.map(rowToListing);
}

export function getListing(db: Database.Database, id: number): BstListing | null {
  const row = db.prepare('SELECT * FROM buy_sell_trade_listings WHERE id = ?').get(id) as
    | ListingRow
    | undefined;
  return row ? rowToListing(row) : null;
}

export function createListing(db: Database.Database, input: CreateBstListingInput): BstListing {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO buy_sell_trade_listings
         (type, manufacturer, item, price, condition, notes, private_notes, location,
          sale_status, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.type,
      input.manufacturer ?? null,
      input.item,
      input.price ?? null,
      input.condition ?? null,
      input.notes ?? null,
      input.privateNotes ?? null,
      input.location ?? null,
      input.saleStatus ?? null,
      input.category ?? null,
      now,
      now,
    );
  return getListing(db, Number(lastInsertRowid))!;
}

/** Partial update — an omitted field means "unchanged", never "clear it". Clearing is done
 *  by sending an explicit `null`. */
export function updateListing(
  db: Database.Database,
  id: number,
  input: UpdateBstListingInput,
): BstListing | null {
  const existing = getListing(db, id);
  if (!existing) return null;
  const pick = <K extends keyof UpdateBstListingInput>(k: K): BstListing[K] =>
    (input[k] === undefined ? existing[k] : input[k]) as BstListing[K];

  db.prepare(
    `UPDATE buy_sell_trade_listings
        SET type = ?, manufacturer = ?, item = ?, price = ?, condition = ?, notes = ?,
            private_notes = ?, location = ?, sale_status = ?, category = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    pick('type'),
    pick('manufacturer'),
    pick('item'),
    pick('price'),
    pick('condition'),
    pick('notes'),
    pick('privateNotes'),
    pick('location'),
    pick('saleStatus'),
    pick('category'),
    Date.now(),
    id,
  );
  return getListing(db, id);
}

export function deleteListing(db: Database.Database, id: number): boolean {
  return db.prepare('DELETE FROM buy_sell_trade_listings WHERE id = ?').run(id).changes > 0;
}

/**
 * Listings that already describe the same thing, case-insensitively, ignoring condition and
 * price — the fields that legitimately differ between two copies of the same item.
 *
 * **Advisory only.** Owning two of something is normal, so nothing here refuses a write; the
 * route uses this to ask for confirmation once, and the answer is the caller's. `excludeId`
 * keeps an edit from flagging the row being edited against itself.
 */
export function findDuplicateListings(
  db: Database.Database,
  key: { type: string; manufacturer?: string | null; item: string },
  excludeId?: number,
): BstListing[] {
  const rows = db
    .prepare(
      `SELECT * FROM buy_sell_trade_listings
        WHERE type = ? COLLATE NOCASE
          AND IFNULL(manufacturer, '') = IFNULL(?, '') COLLATE NOCASE
          AND item = ? COLLATE NOCASE
          AND id IS NOT ?
        ORDER BY id`,
    )
    .all(key.type, key.manufacturer ?? null, key.item, excludeId ?? null) as ListingRow[];
  return rows.map(rowToListing);
}

/* ── CSV import ─────────────────────────────────── */

/**
 * Import pasted CSV. Idempotent on **(type, manufacturer, item, condition)**, case-insensitively,
 * so re-pasting the sheet corrects rows rather than duplicating them.
 *
 * Condition is in the key because duplicates are legal (see `schema.ts`): Steve owns two of some
 * items and they differ by condition and price, so a key without condition would collapse them
 * into one row on every re-import. The residual cost is honest and worth stating — **two sheet
 * rows identical in all four fields collapse to one**. Distinguishing those would mean matching
 * on price too, which changes identity every time he re-prices something.
 *
 * Runs in a transaction: a CSV that fails partway leaves the list exactly as it was, rather
 * than half-imported in a state Steve would have to reconcile by hand.
 */
export function importListingsCsv(db: Database.Database, text: string): BstImportResult {
  const { rows, terms, problems } = parseSheetCsv(text);
  let created = 0;
  let updated = 0;

  const findExisting = db.prepare(
    `SELECT id FROM buy_sell_trade_listings
      WHERE type = ? COLLATE NOCASE
        AND IFNULL(manufacturer, '') = IFNULL(?, '') COLLATE NOCASE
        AND item = ? COLLATE NOCASE
        AND IFNULL(condition, '') = IFNULL(?, '') COLLATE NOCASE
      ORDER BY id
      LIMIT 1`,
  );

  const run = db.transaction((inputs: CreateBstListingInput[]) => {
    for (const input of inputs) {
      const hit = findExisting.get(
        input.type,
        input.manufacturer ?? null,
        input.item,
        input.condition ?? null,
      ) as { id: number } | undefined;
      if (hit) {
        updateListing(db, hit.id, input);
        updated++;
      } else {
        createListing(db, input);
        created++;
      }
    }
  });
  run(rows);

  // Terms are OFFERED, not applied: the caller decides whether to adopt them, so a re-import
  // can never silently overwrite terms edited in the app since the first paste.
  return { created, updated, skipped: problems.length, problems, extractedTerms: terms };
}

/* ── Matches (PD-438) ───────────────────────────── */

interface MatchRow {
  id: number;
  listing_id: number;
  thread_id: string;
  comment_id: string;
  permalink: string;
  author: string;
  author_url: string;
  intent: string;
  excerpt: string;
  matched_at: number;
  dismissed_at: number | null;
  item: string;
  manufacturer: string | null;
  listing_type: string;
  sale_status: string | null;
}

function rowToMatch(r: MatchRow): BstMatch {
  return {
    id: r.id,
    listingId: r.listing_id,
    threadId: r.thread_id,
    commentId: r.comment_id,
    permalink: r.permalink,
    author: r.author,
    authorUrl: r.author_url,
    intent: r.intent as BstMatchIntent,
    excerpt: r.excerpt,
    matchedAt: r.matched_at,
    dismissedAt: r.dismissed_at,
    item: r.item,
    manufacturer: r.manufacturer,
    listingType: r.listing_type as BstListingType,
    saleStatus: r.sale_status as BstSaleStatus | null,
  };
}

const MATCH_SELECT = `
  SELECT m.*, l.item AS item, l.manufacturer AS manufacturer,
         l.type AS listing_type, l.sale_status AS sale_status
    FROM buy_sell_trade_matches m
    JOIN buy_sell_trade_listings l ON l.id = m.listing_id`;

/** Newest first. `includeDismissed` is off by default because the readout is a to-read list,
 *  not an archive — but the archive is one query param away rather than lost. */
export function listMatches(db: Database.Database, includeDismissed = false): BstMatch[] {
  const where = includeDismissed ? '' : ' WHERE m.dismissed_at IS NULL';
  const rows = db
    .prepare(`${MATCH_SELECT}${where} ORDER BY m.matched_at DESC, m.id DESC`)
    .all() as MatchRow[];
  return rows.map(rowToMatch);
}

/** What the collapsed card shows. A COUNT rather than `listMatches().length` — the card renders
 *  on the dashboard grid alongside every other widget and shouldn't pull the whole table. */
export function countOpenMatches(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM buy_sell_trade_matches WHERE dismissed_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/** Dismiss (or un-dismiss) a match. Returns null when there is no such match. */
export function setMatchDismissed(
  db: Database.Database,
  id: number,
  dismissed: boolean,
): BstMatch | null {
  const changed = db
    .prepare('UPDATE buy_sell_trade_matches SET dismissed_at = ? WHERE id = ?')
    .run(dismissed ? Date.now() : null, id).changes;
  if (changed === 0) return null;
  const row = db.prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(id) as MatchRow | undefined;
  return row ? rowToMatch(row) : null;
}

/**
 * Run a thread's comments through the matcher and record what it found. **This is the seam**:
 * PD-471 calls it with comments fetched from Reddit, a test calls it with fixtures, and a
 * hand-pasted thread calls it through `POST /matches/ingest`. Nothing here knows about Reddit.
 *
 * `ON CONFLICT DO NOTHING` is the whole re-notification story. A re-scan of the same thread
 * writes nothing, and — importantly — a match Steve already dismissed is not resurrected with a
 * fresh `dismissed_at IS NULL`. Getting that wrong would make the dismiss button useless every
 * time the weekly job ran.
 */
export function ingestComments(
  db: Database.Database,
  input: { threadId: string; comments: BstCommentInput[] },
): BstIngestResult {
  const listings = listListings(db);
  const matches = matchComments(listings, input.comments);

  const insert = db.prepare(
    `INSERT INTO buy_sell_trade_matches
       (listing_id, thread_id, comment_id, permalink, author, author_url, intent, excerpt, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (listing_id, comment_id) DO NOTHING`,
  );

  let created = 0;
  const run = db.transaction(() => {
    const now = Date.now();
    for (const m of matches) {
      const { changes } = insert.run(
        m.listingId,
        input.threadId,
        m.commentId,
        m.permalink,
        m.author,
        `https://reddit.com/user/${m.author}`,
        m.intent,
        m.excerpt,
        now,
      );
      created += changes;
    }
  });
  run();

  return {
    scanned: input.comments.length,
    matched: matches.length,
    created,
    duplicates: matches.length - created,
  };
}

/* ── Settings ───────────────────────────────────── */

export function getSettings(db: Database.Database): BstSettings {
  const row = db
    .prepare('SELECT terms, updated_at FROM buy_sell_trade_settings WHERE id = 1')
    .get() as { terms: string; updated_at: number } | undefined;
  // bootstrapSchema seeds row 1, so this fallback is belt-and-braces for a stale DB.
  return row ? { terms: row.terms, updatedAt: row.updated_at } : { terms: '', updatedAt: 0 };
}

export function updateSettings(db: Database.Database, terms: string): BstSettings {
  const now = Date.now();
  db.prepare(
    `INSERT INTO buy_sell_trade_settings (id, terms, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET terms = excluded.terms, updated_at = excluded.updated_at`,
  ).run(terms, now);
  return { terms, updatedAt: now };
}
