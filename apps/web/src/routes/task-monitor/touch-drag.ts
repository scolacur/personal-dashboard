export interface CardLayout {
  id: number;
  /** bandKey value – "P0" … "P5" or "none" */
  priority: string;
  /** getBoundingClientRect().top */
  top: number;
  /** getBoundingClientRect().height */
  height: number;
}

/**
 * Computes the `beforeId` insertion point within a priority band.
 *
 * Given a pointer Y, the rank of the card being dragged, and the current
 * on-screen layouts of all cards in the column (excluding the dragged card),
 * returns the id of the card that the dragged card should be inserted before,
 * or null to append at the end of the band.
 *
 * This is the canonical implementation shared by mouse DnD (onColumnDragOver)
 * and touch DnD so both code paths enforce identical priority-band clamping.
 */
export function insertionBeforeId(
  clientY: number,
  draggedRank: number,
  cards: CardLayout[],
  PRIORITY_RANK: Record<string, number>,
): number | null {
  let beforeId: number | null = null;
  for (const c of cards) {
    if (PRIORITY_RANK[c.priority] !== draggedRank) continue;
    if (clientY < c.top + c.height / 2) {
      beforeId = c.id;
      break;
    }
  }
  if (beforeId === null) {
    const nextBand = cards.find((c) => PRIORITY_RANK[c.priority] > draggedRank);
    beforeId = nextBand ? nextBand.id : null;
  }
  return beforeId;
}
