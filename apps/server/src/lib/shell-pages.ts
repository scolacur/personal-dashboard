import type Database from 'better-sqlite3';
import { moveNavPage, PINNED_PAGE_IDS, type MoveError, type NavPage } from '@dashboard/shared';

/**
 * User-managed nav pages (PD-969 — pages become data, from the PD-497 split).
 *
 * Every page except the pinned built-ins (Home, Dev Ops) is a row here: renamable, reorderable and
 * nestable. Home and Dev Ops stay code-defined in `apps/web/src/lib/pages.ts` and never appear in
 * this table, which is what makes them structurally unmovable.
 *
 * `id` matches `shell_page_widgets.page_id`, so the seeded rows keep the widgets they already had.
 */

interface NavPageRow {
  id: string;
  title: string;
  description: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
}

function rowToNavPage(r: NavPageRow): NavPage {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    slug: r.slug,
    parentId: r.parent_id,
    order: r.sort_order,
  };
}

/**
 * The seven pages `pages.ts` defined in code on the day PD-969 landed, minus Home and Dev Ops.
 * A frozen literal, like `SEED_PAGES` in shell-layout.ts: history, not a mirror. Slugs equal the
 * old route segments, so `/productivity` redirects to `/p/productivity`.
 */
const SEED: Omit<NavPage, 'parentId' | 'order'>[] = [
  {
    id: 'productivity',
    title: 'Productivity',
    description: 'Habits, morning routine, focus timer, and journaling.',
    slug: 'productivity',
  },
  {
    id: 'health-fitness',
    title: 'Health / Fitness',
    description: 'Workouts and health tracking.',
    slug: 'health-fitness',
  },
  {
    id: 'music-discovery',
    title: 'Music Discovery',
    description: 'Find and track new music to listen to and add to the library.',
    slug: 'music-discovery',
  },
  {
    id: 'music-production',
    title: 'Music Production',
    description: 'Tools that support the music-making process.',
    slug: 'music-production',
  },
  {
    id: 'event-tracker',
    title: 'Event Tracker',
    description: "Discover live events and log shows you've attended.",
    slug: 'event-tracker',
  },
  {
    id: 'buy-sell-trade',
    title: 'Buy, Sell, Trade',
    description: 'Gear you are buying, selling and trading — and who is asking for it.',
    slug: 'buy-sell-trade',
  },
  {
    id: 'inboxes',
    title: 'Inboxes',
    description: 'One-at-a-time organizational jobs you chip away at over time.',
    slug: 'inboxes',
  },
];

const SEEDED_KEY = 'nav_pages_seeded';

export function bootstrapShellPagesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shell_pages (
      id          TEXT    PRIMARY KEY,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      slug        TEXT    NOT NULL UNIQUE,
      parent_id   TEXT    REFERENCES shell_pages(id),
      sort_order  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shell_pages_parent
      ON shell_pages (parent_id, sort_order);

    CREATE TABLE IF NOT EXISTS shell_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed exactly once, ever, behind a marker — the same reasoning as shell-layout.ts's seed: a
  // later deploy must not resurrect a page the user deleted (PD-970).
  const marker = db.prepare('SELECT value FROM shell_meta WHERE key = ?').get(SEEDED_KEY);
  if (marker) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shell_pages (id, title, description, slug, parent_id, sort_order)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  db.transaction(() => {
    SEED.forEach((p, i) => insert.run(p.id, p.title, p.description, p.slug, i));
    db.prepare('INSERT INTO shell_meta (key, value) VALUES (?, ?)').run(
      SEEDED_KEY,
      String(Date.now()),
    );
  })();
}

export function getNavPages(db: Database.Database): NavPage[] {
  const rows = db
    .prepare(
      `SELECT id, title, description, slug, parent_id, sort_order FROM shell_pages
       ORDER BY parent_id IS NOT NULL, parent_id, sort_order`,
    )
    .all() as NavPageRow[];
  return rows.map(rowToNavPage);
}

export type PatchError = MoveError | 'PINNED' | 'INVALID_TITLE';

/**
 * Apply a PATCH: a rename, a move (`parentId` + `order`), or both. Validation refuses moving a
 * pinned page and any move that would put a page inside its own subtree.
 */
export function patchNavPage(
  db: Database.Database,
  id: string,
  patch: { title?: string; parentId?: string | null; order?: number },
): { pages: NavPage[] } | { error: PatchError } {
  if ((PINNED_PAGE_IDS as readonly string[]).includes(id)) return { error: 'PINNED' };
  if (patch.parentId != null && (PINNED_PAGE_IDS as readonly string[]).includes(patch.parentId)) {
    // Dev Ops keeps its code-defined subpages, and nothing nests under Home.
    return { error: 'PINNED' };
  }

  let pages = getNavPages(db);
  const current = pages.find((p) => p.id === id);
  if (!current) return { error: 'NOT_FOUND' };

  let title = current.title;
  if (patch.title !== undefined) {
    title = patch.title.trim();
    if (title === '') return { error: 'INVALID_TITLE' };
  }

  if (patch.parentId !== undefined || patch.order !== undefined) {
    const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
    const order = patch.order ?? Number.MAX_SAFE_INTEGER; // a bare re-parent appends
    const moved = moveNavPage(pages, id, parentId, order);
    if ('error' in moved) return moved;
    pages = moved.pages;
  }

  const update = db.prepare('UPDATE shell_pages SET parent_id = ?, sort_order = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of pages) update.run(p.parentId, p.order, p.id);
    db.prepare('UPDATE shell_pages SET title = ? WHERE id = ?').run(title, id);
  })();

  return { pages: getNavPages(db) };
}
