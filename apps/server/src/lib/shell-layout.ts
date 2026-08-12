import type Database from 'better-sqlite3';
import type { PageWidget, PageWidgetMap } from '@dashboard/shared';

/**
 * Shell page-membership store (PD-334, D-073).
 *
 * Cross-cutting shell infrastructure rather than any one widget's concern, so it lives in
 * `apps/server/src/lib/` alongside the shared job-run store (PD-442) — the slot PROJECT.md §5
 * reserved for exactly this.
 *
 * Holds **membership and layout in one row**: which widgets are on a page, in what order, at what
 * span. Before D-073 membership was a registry field (`WidgetMeta.pages`) and layout was per-device
 * `localStorage`; both are retired here. The registry now declares only that a widget *exists*.
 *
 * `page_id` is plain TEXT matching `pages.ts`, not a foreign key — user-managed pages are PD-497,
 * which adds `shell_pages` and promotes this to a real FK with a delete cascade. Until then an
 * orphaned row (a page id that no longer exists) is harmless: reads are always page-scoped, so
 * nothing ever asks for it.
 */

interface PageWidgetRow {
  page_id: string;
  widget_id: string;
  sort_order: number;
  cols: number;
  rows: number;
}

function rowToPageWidget(r: PageWidgetRow): PageWidget {
  return { widgetId: r.widget_id, order: r.sort_order, cols: r.cols, rows: r.rows };
}

/**
 * A frozen snapshot of the `WidgetMeta.pages` values as they stood the day D-073 landed, used
 * once to seed the table before that field was deleted.
 *
 * Deliberately a literal, not a read of the registry: the registry lives in `apps/web` and the
 * server cannot import it, and — more to the point — the field this mirrors no longer exists, so
 * there is nothing left to drift from. This is history, not a mirror. Never edit it to add a
 * widget; add the widget from the library like any other.
 */
const SEED_PAGES: Record<string, string[]> = {
  // Home was the auto-catalogue of every non-system widget (`homeWidgets()`). Seeded as it was
  // rather than empty, so the migration is a pure no-visible-change step (D-073); Home is meant
  // to end up hand-curated, but that is a choice made in the UI, not by the seed.
  home: [
    'morning-routine',
    'reminders',
    'habit-log',
    'pomodoro',
    'diary',
    'vision-board',
    'workout-log',
    'music-picker',
    'music-tracker',
    'concert-discovery',
    'acute-strategies-generator',
    'festival-follower',
    'concert-diary',
    'buy-sell-trade',
    'chat',
  ],
  productivity: ['morning-routine', 'reminders', 'habit-log', 'pomodoro', 'diary', 'vision-board'],
  'health-fitness': ['habit-log', 'workout-log'],
  'music-discovery': ['music-picker', 'music-tracker', 'concert-discovery'],
  'music-production': ['acute-strategies-generator'],
  'event-tracker': ['concert-discovery', 'festival-follower', 'concert-diary'],
  'buy-sell-trade': ['buy-sell-trade'],
  devops: ['devops-task-tracker', 'devops-jobs', 'devops-agent'],
};

/** Spans from each widget's `embed.span` at seed time; anything absent defaulted to 1×1. */
const SEED_SPANS: Record<string, { cols: number; rows: number }> = {
  'music-tracker': { cols: 2, rows: 3 },
  'acute-strategies-generator': { cols: 2, rows: 2 },
  'buy-sell-trade': { cols: 2, rows: 1 },
  'devops-task-tracker': { cols: 2, rows: 2 },
  'devops-jobs': { cols: 2, rows: 2 },
  'devops-agent': { cols: 2, rows: 2 },
};

export function bootstrapShellLayoutSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shell_page_widgets (
      page_id    TEXT    NOT NULL,
      widget_id  TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      cols       INTEGER NOT NULL,
      rows       INTEGER NOT NULL,
      PRIMARY KEY (page_id, widget_id)
    );

    /* Every read is "this page's widgets, in order". */
    CREATE INDEX IF NOT EXISTS idx_shell_page_widgets_page
      ON shell_page_widgets (page_id, sort_order);

    /* One-row-per-key store for shell bootstrap markers. */
    CREATE TABLE IF NOT EXISTS shell_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  seedOnce(db);
}

const SEEDED_KEY = 'page_widgets_seeded';

/**
 * Seed the table from `SEED_PAGES`, exactly once, ever.
 *
 * The guard is load-bearing rather than an optimisation: `bootstrapSchema` runs on **every**
 * process start, so an unguarded seed would resurrect on the next deploy every widget the user
 * had deliberately removed. A `shell_meta` marker — not "is the table empty?" — because a user
 * who empties every page is a legitimate state that must survive a restart.
 */
function seedOnce(db: Database.Database): void {
  const marker = db
    .prepare('SELECT value FROM shell_meta WHERE key = ?')
    .get(SEEDED_KEY) as { value: string } | undefined;
  if (marker) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shell_page_widgets (page_id, widget_id, sort_order, cols, rows)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const markSeeded = db.prepare('INSERT INTO shell_meta (key, value) VALUES (?, ?)');

  db.transaction(() => {
    for (const [pageId, widgetIds] of Object.entries(SEED_PAGES)) {
      widgetIds.forEach((widgetId, i) => {
        const span = SEED_SPANS[widgetId] ?? { cols: 1, rows: 1 };
        insert.run(pageId, widgetId, i, span.cols, span.rows);
      });
    }
    markSeeded.run(SEEDED_KEY, String(Date.now()));
  })();
}

/** Every page's membership in one read — the client loads this once at boot (D-073). */
export function getAllPageWidgets(db: Database.Database): PageWidgetMap {
  const rows = db
    .prepare('SELECT page_id, widget_id, sort_order, cols, rows FROM shell_page_widgets ORDER BY page_id, sort_order')
    .all() as PageWidgetRow[];

  const map: PageWidgetMap = {};
  for (const r of rows) {
    (map[r.page_id] ??= []).push(rowToPageWidget(r));
  }
  return map;
}

export function getPageWidgets(db: Database.Database, pageId: string): PageWidget[] {
  const rows = db
    .prepare(
      'SELECT page_id, widget_id, sort_order, cols, rows FROM shell_page_widgets WHERE page_id = ? ORDER BY sort_order',
    )
    .all(pageId) as PageWidgetRow[];
  return rows.map(rowToPageWidget);
}

/**
 * Replace a page's membership wholesale.
 *
 * A whole-array write rather than granular add/remove/move calls: the client already recomputes
 * the entire ordered array for any change (a reorder renumbers every row), so a diff would be
 * reconstructed on both sides for no gain. Delete-then-insert inside one transaction, so a page
 * is never observed half-written.
 *
 * `order` is normalised to the array index — the caller's ordering is authoritative and any
 * `order` values it sends are ignored, which stops duplicate or sparse keys reaching the table.
 */
export function setPageWidgets(
  db: Database.Database,
  pageId: string,
  widgets: PageWidget[],
): PageWidget[] {
  const del = db.prepare('DELETE FROM shell_page_widgets WHERE page_id = ?');
  const insert = db.prepare(
    `INSERT INTO shell_page_widgets (page_id, widget_id, sort_order, cols, rows)
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    del.run(pageId);
    // A duplicate widget id on one page is meaningless (the PK forbids it) — keep the first.
    const seen = new Set<string>();
    let order = 0;
    for (const w of widgets) {
      if (seen.has(w.widgetId)) continue;
      seen.add(w.widgetId);
      insert.run(pageId, w.widgetId, order, Math.max(1, w.cols), Math.max(1, w.rows));
      order += 1;
    }
  })();

  return getPageWidgets(db, pageId);
}
