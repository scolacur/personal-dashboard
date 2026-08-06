import type Database from 'better-sqlite3';
import { BST_DRAFT_FORMATS } from '@dashboard/shared';
import type {
  BstCategory,
  BstCommentInput,
  BstDraft,
  BstDraftFormat,
  BstImportResult,
  BstIngestResult,
  BstListing,
  BstListingType,
  BstMatch,
  BstMatchConfidence,
  BstMatchIntent,
  BstSaleStatus,
  BstSettings,
  CreateBstListingInput,
  UpdateBstListingInput,
} from '@dashboard/shared';
import { parseSheetCsv } from './csv';
import { DEFAULT_TEMPLATES, fillTemplate } from './drafts';
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
  aliases: string | null;
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
    // `?? null` rather than a bare read: a row selected before the column existed has no key
    // at all under `SELECT *`, which surfaces as `undefined` and breaks the declared type.
    aliases: r.aliases ?? null,
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
          sale_status, category, aliases, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.aliases ?? null,
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
            private_notes = ?, location = ?, sale_status = ?, category = ?, aliases = ?,
            updated_at = ?
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
    pick('aliases'),
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
  confidence: string;
  matched_on: string;
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
    // Same `?? null`-shaped reason as `rowToListing.aliases`: a pre-migration row read under
    // `SELECT *` carries no key, and `undefined` is not a BstMatchConfidence.
    confidence: (r.confidence ?? 'confirmed') as BstMatchConfidence,
    matchedOn: r.matched_on ?? '',
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
       (listing_id, thread_id, comment_id, permalink, author, author_url, intent, confidence,
        matched_on, excerpt, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        m.confidence,
        m.matchedOn,
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

interface SettingsRow {
  terms: string;
  template_reddit: string;
  template_facebook: string;
  template_discord: string;
  updated_at: number;
}

/**
 * Settings, with an unset template filled in from `DEFAULT_TEMPLATES` **on read**.
 *
 * Filling in on read rather than seeding at migration time means improving a default reaches an
 * install that has never touched its templates. The cost is that "empty" cannot mean "a post
 * with no template" — which is not a thing anyone wants.
 */
export function getSettings(db: Database.Database): BstSettings {
  const row = db.prepare('SELECT * FROM buy_sell_trade_settings WHERE id = 1').get() as
    | SettingsRow
    | undefined;

  const templates = {} as Record<BstDraftFormat, string>;
  for (const format of BST_DRAFT_FORMATS) {
    const stored = row?.[`template_${format}` as keyof SettingsRow];
    templates[format] =
      typeof stored === 'string' && stored.trim() !== '' ? stored : DEFAULT_TEMPLATES[format];
  }

  // bootstrapSchema seeds row 1, so the missing-row case is belt-and-braces for a stale DB.
  return { terms: row?.terms ?? '', templates, updatedAt: row?.updated_at ?? 0 };
}

/** Partial update: an omitted field is unchanged. Templates are merged per format, so saving
 *  the Reddit one cannot blank the other two. */
export function updateSettings(
  db: Database.Database,
  input: { terms?: string; templates?: Partial<Record<BstDraftFormat, string>> },
): BstSettings {
  const now = Date.now();
  const current = getSettings(db);
  const terms = input.terms ?? current.terms;

  // A template equal to its default is stored as empty, so it keeps tracking the default rather
  // than freezing today's copy of it into the row.
  const stored = BST_DRAFT_FORMATS.map((format) => {
    const value = input.templates?.[format] ?? current.templates[format];
    return value.trim() === DEFAULT_TEMPLATES[format].trim() ? '' : value;
  });

  db.prepare(
    `INSERT INTO buy_sell_trade_settings
       (id, terms, template_reddit, template_facebook, template_discord, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         terms = excluded.terms,
         template_reddit = excluded.template_reddit,
         template_facebook = excluded.template_facebook,
         template_discord = excluded.template_discord,
         updated_at = excluded.updated_at`,
  ).run(terms, ...stored, now);

  return getSettings(db);
}

/* ── Drafts (PD-439) ────────────────────────────── */

interface DraftRow {
  id: number;
  format: string;
  content: string;
  generated_at: number;
}

function rowToDraft(r: DraftRow): BstDraft {
  return {
    id: r.id,
    format: r.format as BstDraftFormat,
    content: r.content,
    generatedAt: r.generated_at,
  };
}

/** Newest first. Bounded because this is a readout, not an export — the page shows the latest
 *  batch and offers the previous ones, and nobody scrolls a year of monthly posts. */
export function listDrafts(db: Database.Database, limit = 60): BstDraft[] {
  const rows = db
    .prepare('SELECT * FROM buy_sell_trade_drafts ORDER BY generated_at DESC, id DESC LIMIT ?')
    .all(limit) as DraftRow[];
  return rows.map(rowToDraft);
}

/**
 * Render every format from the current list and terms, and record the batch.
 *
 * **Always a new batch, never an update.** Regenerating in a month that already has drafts adds
 * a pair rather than mutating the old one — see the schema note: the draft already pasted
 * somewhere is a record of what was offered.
 */
export function generateDrafts(db: Database.Database): BstDraft[] {
  const settings = getSettings(db);
  const listings = listListings(db);
  const at = Date.now();

  const insert = db.prepare(
    'INSERT INTO buy_sell_trade_drafts (format, content, generated_at) VALUES (?, ?, ?)',
  );

  const created: BstDraft[] = [];
  const run = db.transaction(() => {
    for (const format of BST_DRAFT_FORMATS) {
      const content = fillTemplate(settings.templates[format], format, {
        listings,
        terms: settings.terms,
        at,
      });
      const { lastInsertRowid } = insert.run(format, content, at);
      created.push({ id: Number(lastInsertRowid), format, content, generatedAt: at });
    }
  });
  run();

  return created;
}
