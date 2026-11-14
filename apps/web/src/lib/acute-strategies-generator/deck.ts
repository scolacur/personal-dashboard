import type { AcuteStrategyIdea } from '@dashboard/shared';
import { pickRandom } from './utils';

/**
 * Deck Mode (T67): deal the filtered pool like a deck of cards — no idea repeats
 * until every idea in the current pool has come up once, then a fresh round
 * begins. The "seen set" is the set of idea ids drawn in the current round.
 *
 * All functions here are pure (they take the seen set and return a new one) so
 * the deck behaviour is unit-testable without the `.svelte` component —
 * `apps/web` has no component tests.
 */

export interface DeckDraw {
  /** The idea drawn, or null when the pool is empty. */
  idea: AcuteStrategyIdea | null;
  /** The seen set after this draw (new array; input is never mutated). */
  seenIds: number[];
  /** True when the pool was exhausted and this draw opened a fresh round. */
  newRound: boolean;
}

/**
 * Draw the next card from the deck.
 *
 * Candidates are the pool ideas not yet seen this round. When none are left the
 * round is complete: the seen set is cleared and a new round begins. To honour
 * "never the same card twice in a row across a round boundary", the just-drawn
 * card (`lastDrawnId`) is excluded from the first draw of the new round when the
 * pool has more than one idea.
 */
export function drawFromDeck(
  pool: AcuteStrategyIdea[],
  seenIds: number[],
  lastDrawnId: number | null,
): DeckDraw {
  if (pool.length === 0) {
    return { idea: null, seenIds: [...seenIds], newRound: false };
  }

  const seen = new Set(seenIds);
  let candidates = pool.filter((idea) => !seen.has(idea.id));
  let newRound = false;

  if (candidates.length === 0) {
    // Every idea in the current pool has been seen — start a new round.
    newRound = true;
    seen.clear();
    candidates = pool;
    if (pool.length > 1 && lastDrawnId !== null) {
      const withoutLast = candidates.filter((idea) => idea.id !== lastDrawnId);
      if (withoutLast.length > 0) candidates = withoutLast;
    }
  }

  const idea = pickRandom(candidates);
  if (idea) seen.add(idea.id);

  return { idea, seenIds: [...seen], newRound };
}

/**
 * Progress through the current round, scoped to the current (possibly narrowed)
 * pool: how many of the pool's ideas have been seen, out of the pool size.
 * Seen ids outside the current pool (e.g. filtered out) are ignored here.
 */
export function deckProgress(
  pool: AcuteStrategyIdea[],
  seenIds: number[],
): { seen: number; total: number } {
  const seen = new Set(seenIds);
  const seenInPool = pool.reduce((n, idea) => (seen.has(idea.id) ? n + 1 : n), 0);
  return { seen: seenInPool, total: pool.length };
}

/* ── localStorage persistence (per-device convenience; not history) ─────────
   Every read and write is wrapped so the widget works with storage disabled,
   full, or absent (e.g. during SSR). */

const DECK_MODE_KEY = 'asg:deck-mode';
const DECK_SEEN_KEY = 'asg:deck-seen';

export function loadDeckMode(): boolean {
  try {
    return localStorage.getItem(DECK_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveDeckMode(on: boolean): void {
  try {
    localStorage.setItem(DECK_MODE_KEY, on ? 'true' : 'false');
  } catch {
    /* storage unavailable — deck mode simply won't persist */
  }
}

export function loadDeckSeen(): number[] {
  try {
    const raw = localStorage.getItem(DECK_SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    return [];
  }
}

export function saveDeckSeen(seenIds: number[]): void {
  try {
    localStorage.setItem(DECK_SEEN_KEY, JSON.stringify(seenIds));
  } catch {
    /* storage unavailable — the seen set simply won't persist */
  }
}
