import type Database from 'better-sqlite3';
import { addColumn, columnExists, migrate } from '../../migrate';

/**
 * Buy/Sell/Trade widget tables (PD-437, matches PD-438). Namespaced `buy_sell_trade_*` per
 * PROJECT.md §2; times are unix ms integers per §5.
 *
 * **There is deliberately no uniqueness constraint on a listing.** PD-437 shipped one on
 * (type, manufacturer, module) to make the CSV import idempotent, and it was wrong about the
 * domain: Steve owns two of some things, in different condition, at different prices, and each
 * is its own listing. Duplication is now a question the UI asks (`findDuplicateListings` →
 * `DUPLICATE_CONFIRM`) rather than an error the database raises.
 *
 * Import idempotency survives on the narrower key (type, manufacturer, item, condition) — see
 * `importListingsCsv`. That is the honest trade: two sheet rows identical in all four fields
 * collapse to one, and re-pasting the sheet still corrects rather than duplicates.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS buy_sell_trade_listings (
      id            INTEGER PRIMARY KEY,
      type          TEXT    NOT NULL,
      manufacturer  TEXT,
      item          TEXT    NOT NULL,
      price         TEXT,
      condition     TEXT,
      notes         TEXT,
      private_notes TEXT,
      location      TEXT,
      sale_status   TEXT,
      category      TEXT,
      aliases       TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bst_listings_type ON buy_sell_trade_listings (type);

    CREATE TABLE IF NOT EXISTS buy_sell_trade_settings (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      terms             TEXT    NOT NULL DEFAULT '',
      template_reddit   TEXT    NOT NULL DEFAULT '',
      template_facebook TEXT    NOT NULL DEFAULT '',
      template_discord  TEXT    NOT NULL DEFAULT '',
      updated_at        INTEGER NOT NULL
    );

    /* A rendered post (PD-439). History is kept deliberately: regenerating writes a new row
       rather than replacing last month's, because the draft you already pasted somewhere is a
       record of what you offered and at what price. */
    CREATE TABLE IF NOT EXISTS buy_sell_trade_drafts (
      id           INTEGER PRIMARY KEY,
      format       TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      generated_at INTEGER NOT NULL
    );

    /* The readout wants the newest batch first, and a batch is "the rows sharing a
       generated_at". */
    CREATE INDEX IF NOT EXISTS idx_bst_drafts_generated
      ON buy_sell_trade_drafts (generated_at DESC);

    /* One r/modular scan (PD-471).
       Persisted so a failure at 3am is still visible at 9am — loudness that lives only in an
       HTTP response is no use to a scheduled job. The detail column is the per-thread JSON
       breakdown; status is deliberately three-valued (see BstScanStatus) so a partial read can
       never be reported as a clean one.
       NOTE: PD-442's generic job_runs store should absorb this table; it is here because the
       scan needed a durable record before that shared store exists. */
    CREATE TABLE IF NOT EXISTS buy_sell_trade_scans (
      id           INTEGER PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER NOT NULL,
      status       TEXT    NOT NULL,
      error        TEXT,
      detail       TEXT    NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_bst_scans_started
      ON buy_sell_trade_scans (started_at DESC);

    /* One comment that mentioned one listing (PD-438).
       ON DELETE CASCADE is load-bearing rather than decorative: a match whose listing is gone
       has nothing to display — no item, no type, no significance. db.ts sets
       'foreign_keys = ON', and the tests do the same so they can catch it if that ever lapses. */
    CREATE TABLE IF NOT EXISTS buy_sell_trade_matches (
      id           INTEGER PRIMARY KEY,
      listing_id   INTEGER NOT NULL REFERENCES buy_sell_trade_listings(id) ON DELETE CASCADE,
      thread_id    TEXT    NOT NULL,
      comment_id   TEXT    NOT NULL,
      permalink    TEXT    NOT NULL,
      author       TEXT    NOT NULL,
      author_url   TEXT    NOT NULL,
      intent       TEXT    NOT NULL,
      confidence   TEXT    NOT NULL DEFAULT 'confirmed',
      matched_on   TEXT    NOT NULL DEFAULT '',
      excerpt      TEXT    NOT NULL,
      matched_at   INTEGER NOT NULL,
      dismissed_at INTEGER
    );

    /* Re-scanning a thread must never re-notify. This index plus an INSERT ... DO NOTHING is
       what guarantees it — including for matches Steve has already dismissed, which must stay
       dismissed rather than reappearing every week. */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bst_matches_identity
      ON buy_sell_trade_matches (listing_id, comment_id);

    CREATE INDEX IF NOT EXISTS idx_bst_matches_open
      ON buy_sell_trade_matches (dismissed_at, matched_at);
  `);

  // Single settings row, created empty so reads never have to handle "no row yet".
  db.prepare(
    'INSERT OR IGNORE INTO buy_sell_trade_settings (id, terms, updated_at) VALUES (1, ?, ?)',
  ).run('', Date.now());

  /* ── Migrations (2026-08-04) ───────────────────────────────────────────────────────────────
     Order matters: the rename must land before anything else refers to `item`. */

  // `module` → `item`. The list is gear, not modules — Eurorack is just what Steve happens to
  // have most of. RENAME COLUMN is lossless and SQLite rewrites dependent index definitions
  // itself, so this honours migrate.ts's actual rule (no migration may lose data) even though
  // it is not literally additive.
  migrate(db, 'bst_rename_module_to_item', (d) => {
    if (columnExists(d, 'buy_sell_trade_listings', 'module')) {
      d.exec('ALTER TABLE buy_sell_trade_listings RENAME COLUMN module TO item');
    }
  });

  // Notes split into public and private. The existing `notes` column holds what came out of the
  // sheet's Notes column — "og box", "purchased new" — which is post copy, so it stays as the
  // PUBLIC field and the new column is the private one.
  migrate(db, 'bst_add_private_notes', (d) => {
    addColumn(d, 'buy_sell_trade_listings', 'private_notes', 'TEXT');
  });

  // Drop PD-437's uniqueness constraint. See the note at the top of this file: two of the same
  // item in different condition is real data, not a mistake to be prevented.
  migrate(db, 'bst_drop_identity_index', (d) => {
    d.exec('DROP INDEX IF EXISTS idx_bst_listings_identity');
    d.exec(
      `CREATE INDEX IF NOT EXISTS idx_bst_listings_item
         ON buy_sell_trade_listings (item COLLATE NOCASE)`,
    );
  });

  // WTT retired as a listing type. "Want to trade for" is a want, so those rows become WTB —
  // see BST_LISTING_TYPES for why the type went away.
  //
  // An item recorded as BOTH WTB and WTT is the same want written down twice, so the WTT row is
  // dropped rather than carried over as a duplicate. This is a judgement about the data, not a
  // constraint: duplicates are legal now, they are just not what these rows mean.
  migrate(db, 'bst_retire_wtt_type', (d) => {
    d.prepare(
      `DELETE FROM buy_sell_trade_listings
        WHERE type = 'WTT'
          AND EXISTS (
            SELECT 1 FROM buy_sell_trade_listings o
             WHERE o.type = 'WTB'
               AND o.item = buy_sell_trade_listings.item COLLATE NOCASE
               AND IFNULL(o.manufacturer, '') = IFNULL(buy_sell_trade_listings.manufacturer, '')
                     COLLATE NOCASE
          )`,
    ).run();
    d.prepare("UPDATE buy_sell_trade_listings SET type = 'WTB' WHERE type = 'WTT'").run();
  });

  /* ── Migrations (2026-08-05, PD-475) ───────────────────────────────────────────────────────── */

  // Per-listing aliases. See `BstListing.aliases`: the curated table in the matcher cannot know
  // what Steve calls his own gear, and it does not scale past a handful of entries.
  migrate(db, 'bst_add_listing_aliases', (d) => {
    addColumn(d, 'buy_sell_trade_listings', 'aliases', 'TEXT');
  });

  // How sure the matcher was, and which needle fired.
  //
  // Existing rows defaulting to `confirmed` is accurate rather than a convenient fiction: every
  // match written before this column existed was found under the old suppress-generics rule,
  // which only ever recorded corroborated hits. `matched_on` genuinely is unknown for them, and
  // an empty string says so — the UI only shows it on a `possible` match, which no old row is.
  migrate(db, 'bst_add_match_confidence', (d) => {
    addColumn(d, 'buy_sell_trade_matches', 'confidence', "TEXT NOT NULL DEFAULT 'confirmed'");
    addColumn(d, 'buy_sell_trade_matches', 'matched_on', "TEXT NOT NULL DEFAULT ''");
  });

  // Post templates, one per format, editable without a deploy. Empty means "use the seeded
  // default" — see `getSettings`, which fills them in on read rather than at migration time so
  // improving a default reaches an existing install.
  migrate(db, 'bst_add_post_templates', (d) => {
    for (const format of ['reddit', 'facebook', 'discord']) {
      addColumn(d, 'buy_sell_trade_settings', `template_${format}`, "TEXT NOT NULL DEFAULT ''");
    }
  });
}
