import { matchSignificance, type BstMatch, type BstMatchSignificance } from '@dashboard/shared';

// Grouping for the matches readout (PD-438, split by confidence in PD-475). Pure so it can be
// tested without mounting the page — the same split as list-manager.ts.

export interface MatchGroup {
  /** "Make Noise Maths" — what Steve recognises, not the listing id. */
  label: string;
  items: BstMatch[];
  significance: BstMatchSignificance;
}

const RANK: Record<BstMatchSignificance, number> = { high: 0, normal: 1, low: 2 };

/**
 * Group matches by the item they mention, most significant first.
 *
 * Grouped by item rather than by comment because one comment can mention several things and one
 * thing can be mentioned by several people — and because **duplicate listings are legal**, so two
 * rows for the same item would otherwise show the same comment twice.
 *
 * Ordered by significance first: a stranger selling something on Steve's want list is the payoff
 * of the whole scan, and sorting purely by recency buries it under sale-side noise.
 */
export function groupMatches(matches: BstMatch[]): MatchGroup[] {
  // Null-prototype rather than `{}` so an item literally named "__proto__" is just a key.
  const byItem = Object.create(null) as Record<string, BstMatch[]>;
  for (const m of matches) {
    const key = m.manufacturer ? `${m.manufacturer} ${m.item}` : m.item;
    (byItem[key] ??= []).push(m);
  }

  return Object.entries(byItem)
    .map(([label, items]) => ({
      label,
      items,
      significance: items
        .map((m) => matchSignificance({ type: m.listingType, saleStatus: m.saleStatus }, m.intent))
        .sort((a, b) => RANK[a] - RANK[b])[0],
    }))
    .sort((a, b) => RANK[a.significance] - RANK[b.significance] || a.label.localeCompare(b.label));
}

/**
 * The readout's two halves (PD-475 A1).
 *
 * They are separated rather than interleaved-and-badged because they are *read* differently:
 * the confirmed list is worth Steve's attention line by line, and the possible list is worth a
 * skim. A badge in a single list would make him evaluate every row to find out which kind it is,
 * which is the attention cost the whole trade was supposed to be spending deliberately.
 */
export function splitByConfidence(matches: BstMatch[]): {
  confirmed: MatchGroup[];
  possible: MatchGroup[];
} {
  return {
    confirmed: groupMatches(matches.filter((m) => m.confidence === 'confirmed')),
    possible: groupMatches(matches.filter((m) => m.confidence === 'possible')),
  };
}
