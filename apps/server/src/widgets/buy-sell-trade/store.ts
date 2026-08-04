import type Database from 'better-sqlite3';
import type {
  BstCategory,
  BstImportResult,
  BstListing,
  BstListingType,
  BstSaleStatus,
  BstSettings,
  CreateBstListingInput,
  UpdateBstListingInput,
} from '@dashboard/shared';
import { parseSheetCsv } from './csv';

interface ListingRow {
  id: number;
  type: string;
  manufacturer: string | null;
  module: string;
  price: string | null;
  condition: string | null;
  notes: string | null;
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
    module: r.module,
    price: r.price,
    condition: r.condition,
    notes: r.notes,
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
    .prepare('SELECT * FROM buy_sell_trade_listings ORDER BY type, module COLLATE NOCASE')
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
         (type, manufacturer, module, price, condition, notes, location, sale_status, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.type,
      input.manufacturer ?? null,
      input.module,
      input.price ?? null,
      input.condition ?? null,
      input.notes ?? null,
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
        SET type = ?, manufacturer = ?, module = ?, price = ?, condition = ?, notes = ?,
            location = ?, sale_status = ?, category = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    pick('type'),
    pick('manufacturer'),
    pick('module'),
    pick('price'),
    pick('condition'),
    pick('notes'),
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

/* ── CSV import ─────────────────────────────────── */

/**
 * Import pasted CSV. Idempotent on (type, manufacturer, module) case-insensitively, so
 * re-pasting the sheet corrects rows rather than duplicating them — the property the ticket
 * asks for, and the reason the identity index exists.
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
        AND module = ? COLLATE NOCASE`,
  );

  const run = db.transaction((inputs: CreateBstListingInput[]) => {
    for (const input of inputs) {
      const hit = findExisting.get(input.type, input.manufacturer ?? null, input.module) as
        | { id: number }
        | undefined;
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
