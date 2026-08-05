import type { BstCommentInput, BstListing, BstMatchIntent } from '@dashboard/shared';

/**
 * Match r/modular BST comments against Steve's gear list (PD-438).
 *
 * ## The design constraint: precision, not recall
 *
 * This runs weekly and its output is a list Steve reads. A **false match costs him attention
 * every single week**; a missed match costs him one trade. Those are not symmetric, so every
 * judgement call below is resolved towards *not matching*.
 *
 * That matters more than it sounds, because his list contains module names that are also
 * ordinary modular vocabulary: `Mix`, `VCA`, `Slice`, `Loop`, `Qua`, `Helium`, `Where?`. A
 * substring match on "mix" flags roughly every comment in a BST thread. So a name that is
 * generic on its own does not match alone — it must be corroborated by the manufacturer
 * appearing *near* it ("2hp Mix"), and if the listing has no manufacturer to corroborate with,
 * the generic name cannot match at all.
 *
 * ## Why nothing here touches Reddit
 *
 * The input is `BstCommentInput` — `{ id, author, body, permalink }`. The matcher does not know
 * where comments came from, which keeps it testable against fixtures and keeps a hand-pasted
 * thread a working fallback for as long as API approval is outstanding (PD-471).
 */

/* ── Normalisation ──────────────────────────────── */

/**
 * Fold text to a single space-delimited token stream so that matching can be done on whole
 * tokens rather than substrings.
 *
 * Deliberately does NOT strip diacritics or transliterate: two of Steve's modules are Cyrillic
 * (`Пуск-3`, `СЛИМИКС …`) and lowercasing is all they need. Apostrophes are *removed* rather
 * than spaced so "Pam's" and "Pams" fold together; every other punctuation mark becomes a
 * separator, which is what turns "Пуск-3" and "Пуск 3" into the same thing.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A trailing parenthetical on an item name is a variant qualifier, not part of what people
 * type: `hrylo (gold)`, `Loop (Silver)`. Keep the full name for display, match on the core.
 */
export function coreName(item: string): string {
  return normalize(item.replace(/\s*\([^)]*\)\s*$/, '')) || normalize(item);
}

/** Whole-token containment: is `needle` present in `haystack` as a complete token sequence?
 *  Both must already be normalised. Returns the index in the *padded* haystack, or -1. */
function findToken(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1;
  const idx = ` ${haystack} `.indexOf(` ${needle} `, from);
  return idx;
}

/* ── Genericity ─────────────────────────────────── */

/**
 * Names that mean something in a BST thread other than "this specific module". A needle in this
 * set, or shorter than `MIN_DISTINCTIVE_LENGTH`, requires the manufacturer nearby before it
 * counts.
 *
 * Two kinds of entry, both drawn from what is actually on Steve's list and what actually
 * appears in r/modular comments:
 *   1. modular vocabulary — someone writes "vca" meaning any VCA, not Steve's `VCA`;
 *   2. plain English words that happen to be module names — `Slice`, `Helium`, `Where?`.
 *
 * **Adding to this list is cheap and safe; removing from it is not.** An entry only ever costs
 * recall on listings that have no manufacturer recorded.
 */
export const GENERIC_TERMS = new Set([
  // modular vocabulary
  'mix',
  'mixer',
  'vca',
  'vcf',
  'vco',
  'lfo',
  'env',
  'envelope',
  'filter',
  'clock',
  'mult',
  'mults',
  'buffered mult',
  'attenuator',
  'attenuverter',
  'sequencer',
  'seq',
  'quantizer',
  'sampler',
  'delay',
  'reverb',
  'verb',
  'drive',
  'noise',
  'random',
  'logic',
  'switch',
  'gate',
  'trigger',
  'output',
  'input',
  'case',
  'power',
  'psu',
  'rack',
  'row',
  'blank',
  'blanks',
  'panel',
  'cable',
  'cables',
  'module',
  'modules',
  'utility',
  'utilities',
  'loop',
  'looper',
  'slice',
  'sync',
  'midi',
  'usb',
  'audio',
  'stereo',
  'mono',
  // plain words that are also names on the list
  'where',
  'helium',
  'orb',
  'motion',
  'pro',
  'plus',
  'one',
  'two',
  'three',
]);

/** Below this, a single-token name is too collidable to stand alone — `Qua`, `OPTX` is 4 so it
 *  survives, `Qua` does not. Chosen from the real list rather than from theory. */
const MIN_DISTINCTIVE_LENGTH = 4;

/**
 * Curated aliases: what people type when they don't type the name on the box. Keyed by the
 * normalised core name of the listing.
 *
 * These are *distinctive by construction* — each was judged individually, so a short alias like
 * `ppw` is trusted where a short module name would not be. Case and punctuation are handled by
 * `normalize`, so only genuinely different words belong here ("MATHS" and "Maths" do not).
 */
export const MODULE_ALIASES: Record<string, string[]> = {
  maths: ['maths v2', 'maths v3'],
  'pamelas pro workout': ['pams pro workout', 'ppw', 'pamelas', 'pams'],
  'pamelas new workout': ['pams new workout', 'pnw', 'pamelas', 'pams'],
  'disting mk4': ['disting mk 4', 'disting'],
  'disting ex': ['disting'],
  chronoblob: ['chronoblob ii', 'chronoblob 2'],
  quadrax: ['quad rax'],
  'ultra perc': ['ultraperc'],
  mmmidi: ['mm midi'],
  quadigy: ['quadigy 4'],
};

/** Is this needle safe to match on its own, or does it need the manufacturer next to it? */
export function isGeneric(needle: string): boolean {
  if (GENERIC_TERMS.has(needle)) return true;
  // Multi-token names ("ultra perc", "powered midi 1 4 splitter") are specific enough as-is.
  if (needle.includes(' ')) return false;
  return needle.length < MIN_DISTINCTIVE_LENGTH;
}

/* ── Needles ────────────────────────────────────── */

export interface Needle {
  text: string;
  /** Generic needles only count when corroborated by the manufacturer nearby. */
  generic: boolean;
}

/** Every string that should be taken as a mention of this listing, with its genericity. */
export function needlesFor(listing: Pick<BstListing, 'item'>): Needle[] {
  const core = coreName(listing.item);
  if (!core) return [];
  const out: Needle[] = [{ text: core, generic: isGeneric(core) }];
  for (const alias of MODULE_ALIASES[core] ?? []) {
    const t = normalize(alias);
    // Curated: trusted even when short. That is the whole point of curating them.
    if (t && !out.some((n) => n.text === t)) out.push({ text: t, generic: false });
  }
  return out;
}

/**
 * Corroboration window, in characters of normalised text either side of the mention. Sized for
 * how people actually write a line item — "2hp Mix", "Mix (2hp)", "2hp — Mix $60" — and
 * deliberately too small to reach the next bullet, so a comment listing "2hp Verb" and
 * "Doepfer mix" on separate lines does not corroborate itself.
 */
const CORROBORATION_WINDOW = 40;

/** Manufacturer tokens worth corroborating on. "Make Noise" corroborates as a phrase; a maker
 *  whose name is one short token ("ALM", "2hp") still works because we look for the whole
 *  normalised name, not its parts. */
function manufacturerNeedle(listing: Pick<BstListing, 'manufacturer'>): string | null {
  const m = normalize(listing.manufacturer ?? '');
  return m || null;
}

/* ── Intent ─────────────────────────────────────── */

/**
 * Markers that announce a section of a BST comment. Ordered longest-first at build time so
 * "want to buy" wins over a bare "buy" would-be prefix.
 *
 * Kept tight on purpose. Loose phrasing like "i have" or "looking at" was considered and
 * rejected: it fires on ordinary conversation, and a wrong intent is worse than `unknown` —
 * Steve opens the thread expecting a seller and finds a buyer.
 */
const INTENT_MARKERS: ReadonlyArray<{ marker: string; intent: BstMatchIntent }> = [
  { marker: 'want to sell', intent: 'WTS' },
  { marker: 'want to buy', intent: 'WTB' },
  { marker: 'want to trade', intent: 'WTT' },
  { marker: 'in search of', intent: 'WTB' },
  { marker: 'looking for', intent: 'WTB' },
  { marker: 'for sale', intent: 'WTS' },
  { marker: 'wts', intent: 'WTS' },
  { marker: 'wtb', intent: 'WTB' },
  { marker: 'wtt', intent: 'WTT' },
  { marker: 'wttf', intent: 'WTT' },
  { marker: 'selling', intent: 'WTS' },
  { marker: 'buying', intent: 'WTB' },
  { marker: 'trading', intent: 'WTT' },
  { marker: 'iso', intent: 'WTB' },
  { marker: 'fs', intent: 'WTS' },
  { marker: 'ft', intent: 'WTT' },
];

interface MarkerHit {
  at: number;
  intent: BstMatchIntent;
}

/** Every intent marker in the comment, in the order they appear. */
function findMarkers(text: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const { marker, intent } of INTENT_MARKERS) {
    let from = 0;
    for (;;) {
      const at = findToken(text, marker, from);
      if (at < 0) break;
      hits.push({ at, intent });
      from = at + 1;
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * Infer what the commenter wants to do with *this* mention.
 *
 * BST comments are section-shaped, not uniform — one comment routinely carries both halves:
 *
 *     WTS: Maths $250, Ultra Perc $380
 *     WTB: Quadrax
 *
 * So intent is taken from the **nearest marker before the mention**, not from the comment as a
 * whole. A comment-wide vote would label the Quadrax line "selling", which is precisely the kind
 * of confident wrongness this feature cannot afford.
 *
 * With no marker before the mention: if the whole comment carries exactly one *kind* of marker,
 * use it — a comment titled "WTS" with the module in the first line is unambiguous. Otherwise
 * `unknown`.
 *
 * @param text normalised comment body
 * @param at index of the mention within the *padded* normalised body (as `findToken` returns)
 */
export function inferIntent(text: string, at: number): BstMatchIntent {
  const markers = findMarkers(text);
  if (markers.length === 0) return 'unknown';

  let last: MarkerHit | null = null;
  for (const hit of markers) {
    if (hit.at <= at) last = hit;
    else break;
  }
  if (last) {
    const nearest = last;
    // Two different markers at the same position means the marker text itself is ambiguous;
    // that can't happen with the current table, but don't silently pick one if it ever does.
    const tied = markers.filter((h) => h.at === nearest.at);
    return tied.every((h) => h.intent === nearest.intent) ? nearest.intent : 'unknown';
  }

  const kinds = new Set(markers.map((h) => h.intent));
  return kinds.size === 1 ? [...kinds][0] : 'unknown';
}

/* ── Excerpt ────────────────────────────────────── */

const EXCERPT_RADIUS = 90;

/**
 * A window of the ORIGINAL comment around the mention. Original, not normalised: Steve reads
 * this, and "$250 shipped, og box" is worth more to him than "250 shipped og box".
 *
 * The normalised index doesn't map back to the original, so this re-finds the needle in the
 * original text case-insensitively and falls back to the head of the comment if the punctuation
 * folding means it isn't literally there.
 */
export function excerptFor(body: string, needle: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(needle.split(' ')[0]);
  if (idx < 0) return flat.slice(0, EXCERPT_RADIUS * 2).trim();
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(flat.length, idx + needle.length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/* ── Matching ───────────────────────────────────── */

export interface CommentMatch {
  listingId: number;
  commentId: string;
  author: string;
  permalink: string;
  intent: BstMatchIntent;
  excerpt: string;
  /** Which needle fired. Kept for tests and for explaining a surprising match. */
  matchedOn: string;
}

/**
 * Find every (listing, comment) pair in a batch. At most one match per pair — a comment that
 * mentions Maths three times is one match, and the first mention is the one that sets intent.
 */
export function matchComments(listings: BstListing[], comments: BstCommentInput[]): CommentMatch[] {
  const prepared = listings.map((listing) => ({
    listing,
    needles: needlesFor(listing),
    maker: manufacturerNeedle(listing),
  }));

  const out: CommentMatch[] = [];
  for (const comment of comments) {
    const text = normalize(comment.body);
    if (!text) continue;

    for (const { listing, needles, maker } of prepared) {
      const hit = firstHit(text, needles, maker);
      if (!hit) continue;
      out.push({
        listingId: listing.id,
        commentId: comment.id,
        author: comment.author,
        permalink: comment.permalink,
        intent: inferIntent(text, hit.at),
        excerpt: excerptFor(comment.body, hit.needle),
        matchedOn: hit.needle,
      });
    }
  }
  return out;
}

/** The earliest qualifying mention of any of this listing's needles, or null. */
function firstHit(
  text: string,
  needles: Needle[],
  maker: string | null,
): { at: number; needle: string } | null {
  let best: { at: number; needle: string } | null = null;
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = findToken(text, needle.text, from);
      if (at < 0) break;
      from = at + 1;
      // A generic name with no manufacturer to corroborate it can never match. This is the
      // precision trade stated as code: Steve loses a `Mix` hit rather than gaining a weekly
      // false one.
      if (!needle.generic || (maker && corroborated(text, at, needle.text, maker))) {
        if (!best || at < best.at) best = { at, needle: needle.text };
        break;
      }
    }
  }
  return best;
}

/** Does the manufacturer appear close enough to this mention to vouch for it? */
function corroborated(text: string, at: number, needle: string, maker: string): boolean {
  const start = Math.max(0, at - CORROBORATION_WINDOW);
  const end = Math.min(text.length, at + needle.length + CORROBORATION_WINDOW);
  return findToken(text.slice(start, end), maker) >= 0;
}
