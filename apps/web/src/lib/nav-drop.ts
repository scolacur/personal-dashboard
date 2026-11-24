import { isSelfOrDescendant, type NavRow } from '@dashboard/shared';

/**
 * Side-nav Edit-mode drop math (PD-969 — Spotify-style drag). Pure, so it is unit-tested; the
 * component only measures rows and draws the line this returns.
 *
 * Each row splits vertically into three zones:
 *
 *   ┌──────────────────────┐  0
 *   │ before (sibling)     │      full-width line above the row
 *   ├──────────────────────┤  BEFORE_END
 *   │ child                │      indented line below the row: drop *into* it
 *   ├──────────────────────┤  CHILD_END
 *   │ after (sibling)      │      full-width line below the row
 *   └──────────────────────┘  1
 *
 * A row that already has children shows them expanded right beneath it, so "after" would draw a
 * line between the parent and its first child while meaning "after the whole subtree". That is
 * misleading, so for such rows the bottom half is entirely the child zone.
 */
export const BEFORE_END = 0.5;
export const CHILD_END = 0.8;

export interface NavDrop {
  /** Where the page lands — the args for `moveNavPage`. */
  parentId: string | null;
  index: number;
  /** Which row the line is drawn against, and on which edge. `rowIndex === rows.length` means
   *  the end of the list (drawn above the pinned Dev Ops row). */
  rowIndex: number;
  edge: 'before' | 'after';
  /** Indent depth of the line: the depth the dropped page will have. */
  depth: number;
}

/** Position of `row` among its siblings once the dragged page is lifted out. */
function siblingPosition(rows: NavRow[], row: NavRow, draggingId: string): number {
  return rows
    .filter((r) => r.page.parentId === row.page.parentId && r.page.id !== draggingId)
    .sort((a, b) => a.page.order - b.page.order)
    .findIndex((r) => r.page.id === row.page.id);
}

/**
 * The drop for a pointer `fraction` (0 = top edge, 1 = bottom edge) of the way down
 * `rows[rowIndex]` while dragging `draggingId`. `null` when the hover is not a legal target: the
 * dragged page itself or anything inside it.
 */
export function computeDrop(
  rows: NavRow[],
  rowIndex: number,
  fraction: number,
  draggingId: string,
): NavDrop | null {
  const row = rows[rowIndex];
  if (!row) return null;
  const pages = rows.map((r) => r.page);
  if (isSelfOrDescendant(pages, draggingId, row.page.id)) return null;

  const pos = siblingPosition(rows, row, draggingId);
  const f = Math.max(0, Math.min(1, fraction));

  if (f < BEFORE_END) {
    return { parentId: row.page.parentId, index: pos, rowIndex, edge: 'before', depth: row.depth };
  }
  if (f < CHILD_END || row.hasChildren) {
    return { parentId: row.page.id, index: 0, rowIndex, edge: 'after', depth: row.depth + 1 };
  }
  return { parentId: row.page.parentId, index: pos + 1, rowIndex, edge: 'after', depth: row.depth };
}

/** Dropping on the pinned Dev Ops row: the end of the top level. Dev Ops itself never moves. */
export function dropAtEnd(rows: NavRow[], draggingId: string): NavDrop {
  const topLevel = rows.filter((r) => r.page.parentId === null && r.page.id !== draggingId).length;
  return { parentId: null, index: topLevel, rowIndex: rows.length, edge: 'before', depth: 0 };
}

/** Whether a drop would leave the page exactly where it already is — no request needed. */
export function isNoopDrop(rows: NavRow[], draggingId: string, drop: NavDrop): boolean {
  const row = rows.find((r) => r.page.id === draggingId);
  if (!row || row.page.parentId !== drop.parentId) return false;
  return siblingPosition(rows, row, '') === drop.index;
}
