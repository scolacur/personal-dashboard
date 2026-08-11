import {
  isIgnoredAuthor,
  parseAliases,
  type BstCommentInput,
  type BstListing,
  type BstMatchConfidence,
  type BstMatchIntent,
} from '@dashboard/shared';

/**
 * Match r/modular BST comments against Steve's gear list (PD-438, retuned by PD-475).
 *
 * ## The design constraint: recall, with the uncertainty labelled
 *
 * PD-438 shipped this the other way round — precision first, on the reasoning that a false match
 * costs attention every week while a miss costs one trade. **Steve reversed that premise**
 * (D-065, amended by PD-475): *"I'd rather spend 2 seconds of attention vs lose out on
 * potentially a lot of money."* It is his attention budget, so it is his call to make.
 *
 * The change that actually implements it is not a wider threshold — it is **never discarding**.
 * A mention the matcher cannot vouch for is recorded as `possible` rather than dropped, and the
 * readout puts those in their own collapsed group. Widening the thresholds alone would still
 * throw away the cases that motivated the reversal.
 *
 * That matters because his list contains names that are also ordinary modular vocabulary:
 * `Mix`, `VCA`, `Slice`, `Loop`, `Where?`. A comment saying "anyone got a spare mix?" still
 * produces a hit on his `Mix` — it is just labelled `possible`, and he skims past it.
 *
 * **The known cost, stated plainly:** generic names now fire on almost every comment in a thread.
 * The `possible` group is expected to be long. If it turns out to be unreadable in practice, the
 * lever is `GENERIC_TERMS` plus a floor on what may be recorded at all — not a return to
 * suppression, which is the thing Steve rejected.
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
 * separator, which is what turns "Пуск-3" and "Пуск 3" into the same thing — and what makes
 * hyphens, full stops and capitalisation irrelevant to a match.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Where one line item sits inside a normalised comment. Half-open: `[start, end)`. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A comment folded for matching: one flat token stream, plus the line-item boundaries that
 *  `normalize` would otherwise have erased. */
export interface NormalizedComment {
  text: string;
  lines: LineSpan[];
}

/**
 * Split a comment into **line items** and normalise each, keeping global offsets.
 *
 * The split is newlines and explicit bullet characters, and deliberately nothing else:
 *
 * - **not commas** — "Make Noise Maths, mint, $250" is one item, and splitting it would put the
 *   maker in a different cell from the thing it vouches for;
 * - **not `|`** — that is the column separator in a markdown table, which is exactly how a
 *   tidy BST comment is written. Splitting on it would break corroboration precisely for the
 *   people who formatted their comment well;
 * - **not `-`** — `A-111-5` and `Pico-DSP` are full of them.
 */
export function normalizeComment(body: string): NormalizedComment {
  const parts: string[] = [];
  const lines: LineSpan[] = [];
  let cursor = 0;
  for (const raw of body.split(/\r?\n|[•·▪●]/)) {
    const n = normalize(raw);
    if (!n) continue;
    parts.push(n);
    lines.push({ start: cursor, end: cursor + n.length });
    cursor += n.length + 1; // +1 for the space the join inserts
  }
  return { text: parts.join(' '), lines };
}

/**
 * A trailing parenthetical on an item name is a variant qualifier, not part of what people
 * type: `hrylo (gold)`, `Loop (Silver)`. Keep the full name for display, match on the core.
 */
export function coreName(item: string): string {
  return normalize(item.replace(/\s*\([^)]*\)\s*$/, '')) || normalize(item);
}

/** Whole-token containment: is `needle` present in `haystack` as a complete token sequence?
 *  Both must already be normalised. Returns the index of the match, or -1. */
function findToken(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1;
  return ` ${haystack} `.indexOf(` ${needle} `, from);
}

/* ── Genericity ─────────────────────────────────── */

/**
 * Names that mean something in a BST thread other than "this specific module". A needle in this
 * set, or shorter than `MIN_DISTINCTIVE_LENGTH`, needs the manufacturer nearby before the match
 * can be called `confirmed`.
 *
 * Two kinds of entry, both drawn from what is actually on Steve's list and what actually
 * appears in r/modular comments:
 *   1. modular vocabulary — someone writes "vca" meaning any VCA, not Steve's `VCA`;
 *   2. plain English words that happen to be module names — `Slice`, `Helium`, `Where?`.
 *
 * **Since PD-475 an entry here no longer costs a match, only its confidence.** Under PD-438 it
 * could suppress a listing entirely; now the worst it does is move a hit into the "Possible
 * matches" group. Adding to this list is therefore cheaper than it used to be.
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
 * **Defaults, not the whole story.** These are merged with the listing's own `aliases` field
 * (PD-475) — a hard-coded table here cannot know that Steve's `A-111-5 Mini Synth Voice` gets
 * called "A-111-5", and it does not scale to a 52-row list that changes.
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

/**
 * Genericity for a **human-written alias**, curated or per-listing. The length floor does not
 * apply: `ppw` is short precisely because that is what people type, and a human wrote it down
 * for this listing on purpose. Ordinary modular vocabulary is still ordinary vocabulary though —
 * typing "mix" into the aliases box cannot make the word distinctive.
 */
function isGenericAlias(needle: string): boolean {
  return GENERIC_TERMS.has(needle);
}

/* ── Derived aliases (PD-475 A4) ────────────────── */

/** Trailing words that name the *kind* of thing rather than the thing: people drop them.
 *  Stripping one is always a guess, so what it produces is only ever a `possible` match. */
const CATEGORY_TAILS = new Set([
  'pedal',
  'pedals',
  'module',
  'modules',
  'synth',
  'synthesizer',
  'synthesiser',
  'sequencer',
  'eurorack',
  'expander',
  'edition',
]);

/**
 * The leading model number, if the name starts with one: `A-111-5 Mini Synth Voice` -> `a 111 5`.
 *
 * Requires both a digit and a letter, so a bare "4" or "1010" is not mistaken for one, and skips
 * the token when it is really the manufacturer — `2hp Mix` starts with "2hp", and deriving that
 * as an alias for `Mix` would match every 2hp module in the thread.
 */
function leadingModelNumber(
  item: string,
  maker: string | null,
  knownMakers: ReadonlySet<string> = new Set(),
): string | null {
  const first = item.trim().split(/\s+/)[0] ?? '';
  if (!/\d/.test(first) || !/\p{L}/u.test(first)) return null;
  const n = normalize(first);
  if (n.length < 3) return null;
  if (maker && (maker === n || maker.startsWith(`${n} `))) return null;
  // The listing's OWN manufacturer field is not enough. Found against real data (2026-08-07):
  // the WTB row `2hp Rout` records no manufacturer, so `2hp` looked like a model number and was
  // derived as an alias — which then matched every 2hp module anyone mentioned, producing ~8 of
  // 39 possible matches from one row. `2hp` is a manufacturer on OTHER rows of the same list, so
  // the vocabulary to check against is the whole list, not the row.
  if (knownMakers.has(n)) return null;
  return n;
}

/**
 * Shortenings of the full name that people actually type. Each is a guess, so each is recorded
 * at `possible` confidence:
 *
 *   `Memory Man with Hazarai Pedal` -> `memory man with hazarai` -> `memory man`
 *   `Make Noise Maths`             -> `maths`   (manufacturer already in its own field)
 */
function shortenings(core: string, maker: string | null): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.trim();
    // Four characters of actual content, counted with the spaces removed. Token count is the
    // tempting measure and it is wrong: stripping the tail off "Doepfer A-1 Module" leaves the
    // two-token "a 1", which is a fragment, not a name.
    if (t && t !== core && !out.includes(t) && t.replace(/ /g, '').length >= 4) out.push(t);
  };

  let base = core;

  // The manufacturer repeated inside the item name — very common in an imported sheet.
  if (maker && base.startsWith(`${maker} `)) {
    base = base.slice(maker.length + 1);
    push(base);
  }

  // A trailing category noun.
  const tokens = base.split(' ');
  if (tokens.length > 1 && CATEGORY_TAILS.has(tokens[tokens.length - 1])) {
    base = tokens.slice(0, -1).join(' ');
    push(base);
  }

  // A trailing "with …" clause — "Memory Man with Hazarai" is what the box says; "Memory Man"
  // is what people write.
  const withAt = base.indexOf(' with ');
  if (withAt > 0) push(base.slice(0, withAt));

  return out;
}

/**
 * The ways people write a model number when they don't copy the punctuation off the panel:
 * `a 111 5` is also typed `A111-5`, `A-1115`, `A1115`.
 *
 * `normalize` turns every separator into a space, so those forms are *different token streams* —
 * "a111 5" does not contain the tokens "a 111 5". Rather than teach matching about punctuation,
 * generate the joined variants as needles of their own.
 *
 * Only for needles carrying a digit (a model number is the case people abbreviate this way), and
 * capped at four tokens because the variants are 2^(n-1).
 */
function joinVariants(text: string): string[] {
  const tokens = text.split(' ');
  if (tokens.length < 2 || tokens.length > 4 || !/\d/.test(text)) return [];

  const out: string[] = [];
  const gaps = tokens.length - 1;
  // Each bit decides whether gap i is a space (0) or nothing (1). Skip 0 — that is `text`.
  for (let mask = 1; mask < 1 << gaps; mask++) {
    let s = tokens[0];
    for (let i = 0; i < gaps; i++) s += (mask & (1 << i) ? '' : ' ') + tokens[i + 1];
    out.push(s);
  }
  return out;
}

/* ── Needles ────────────────────────────────────── */

export interface Needle {
  text: string;
  /** Needs the manufacturer nearby to count as `confirmed`. */
  generic: boolean;
  /** Machine-derived (`shortenings` / `leadingModelNumber`) rather than written by a human.
   *  Never `confirmed` on its own — corroboration promotes it. */
  derived: boolean;
}

/** Every string that should be taken as a mention of this listing, and how far each is trusted. */
export function needlesFor(
  listing: Pick<BstListing, 'item' | 'manufacturer' | 'aliases'>,
  /** Every manufacturer named anywhere on the list — see `leadingModelNumber` for why one row's
   *  own field is not enough. `matchComments` supplies it; callers testing one listing may omit. */
  knownMakers: ReadonlySet<string> = new Set(),
): Needle[] {
  const core = coreName(listing.item);
  if (!core) return [];
  const maker = manufacturerNeedle(listing);

  const out: Needle[] = [{ text: core, generic: isGeneric(core), derived: false }];
  const add = (raw: string, opts: { derived: boolean }): void => {
    const text = normalize(raw);
    if (!text || out.some((n) => n.text === text)) return;
    out.push({
      text,
      generic: opts.derived ? isGeneric(text) : isGenericAlias(text),
      derived: opts.derived,
    });
  };

  // Human-written, most trusted first. Steve's own aliases and the curated defaults are treated
  // the same way — both are somebody deciding, for this listing, what people call it.
  for (const alias of parseAliases(listing.aliases)) add(alias, { derived: false });
  for (const alias of MODULE_ALIASES[core] ?? []) add(alias, { derived: false });

  // Machine-derived.
  const model = leadingModelNumber(listing.item, maker, knownMakers);
  if (model) add(model, { derived: true });
  for (const short of shortenings(core, maker)) add(short, { derived: true });

  // Punctuation-dropped spellings of anything above that carries a model number. Derived, so
  // they only ever produce a `possible` match on their own.
  for (const needle of [...out]) {
    for (const variant of joinVariants(needle.text)) add(variant, { derived: true });
  }

  return out;
}

/**
 * How far the manufacturer may sit from a mention and still vouch for it.
 *
 * The real question is "does the maker appear in the same line item", which is why the primary
 * boundary is the line (PD-475 A2, replacing PD-438's flat ±40 characters — too tight to reach
 * the other end of "Doepfer A-111-5 Mini Synth Voice — $90"). This cap is the backstop for the
 * comment written as one long unbroken paragraph, where "the same line" is the whole thing and
 * would otherwise let any maker vouch for any name.
 */
const MAX_CORROBORATION_DISTANCE = 120;

/** Manufacturer tokens worth corroborating on. "Make Noise" corroborates as a phrase; a maker
 *  whose name is one short token ("ALM", "2hp") still works because we look for the whole
 *  normalised name, not its parts. */
function manufacturerNeedle(listing: Pick<BstListing, 'manufacturer'>): string | null {
  const m = normalize(listing.manufacturer ?? '');
  return m || null;
}

/** The line item containing this offset. Falls back to the whole comment, which only happens
 *  if a caller passes an offset from a differently-normalised string. */
function lineContaining(lines: LineSpan[], at: number, textLength: number): LineSpan {
  return lines.find((l) => at >= l.start && at < l.end) ?? { start: 0, end: textLength };
}

/**
 * Does the manufacturer appear close enough to this mention to vouch for it?
 *
 * Searches the whole text and tests each hit against the window, rather than slicing the text
 * and searching that. Slicing is the tempting version and it is wrong: a cut through the middle
 * of a word manufactures a token boundary, so a window starting inside "palm" would find the
 * maker "ALM".
 */
function corroborated(
  doc: NormalizedComment,
  at: number,
  needleLength: number,
  maker: string,
): boolean {
  const line = lineContaining(doc.lines, at, doc.text.length);
  const lo = Math.max(line.start, at - MAX_CORROBORATION_DISTANCE);
  const hi = Math.min(line.end, at + needleLength + MAX_CORROBORATION_DISTANCE);

  let from = 0;
  for (;;) {
    const found = findToken(doc.text, maker, from);
    if (found < 0) return false;
    if (found >= lo && found + maker.length <= hi) return true;
    from = found + 1;
  }
}

/* ── Intent ─────────────────────────────────────── */

/**
 * Markers that announce a section of a BST comment. Ordered longest-first at build time so
 * "want to buy" wins over a bare "buy" would-be prefix.
 *
 * Kept tight on purpose. Loose phrasing like "i have" or "looking at" was considered and
 * rejected: it fires on ordinary conversation, and a wrong intent is worse than `unknown` —
 * Steve opens the thread expecting a seller and finds a buyer. **This is deliberately not
 * loosened by PD-475**: that ticket widens what counts as a *mention*, and an uncertain mention
 * is now recorded as `possible`. There is no equivalent escape hatch for a wrong intent.
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
 * of confident wrongness this feature cannot afford. Note this looks across line items on
 * purpose — a "WTS" heading governs the bullets under it.
 *
 * With no marker before the mention: if the whole comment carries exactly one *kind* of marker,
 * use it — a comment titled "WTS" with the module in the first line is unambiguous. Otherwise
 * `unknown`.
 *
 * @param text normalised comment body
 * @param at index of the mention within it (as `findToken` returns)
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
  /** Whether the evidence stands on its own. `possible` hits are recorded, not discarded — see
   *  the note at the top of this file. */
  confidence: BstMatchConfidence;
  excerpt: string;
  /** Which needle fired. Kept for tests, and shown to Steve on a `possible` match so a
   *  surprising hit explains itself. */
  matchedOn: string;
}

/**
 * Find every (listing, comment) pair in a batch. At most one match per pair — a comment that
 * mentions Maths three times is one match, and the mention that wins sets the intent.
 */
export function matchComments(listings: BstListing[], comments: BstCommentInput[]): CommentMatch[] {
  // Manufacturer vocabulary drawn from the whole list, so a maker recorded on one row stops
  // another row's identically-prefixed name being mistaken for a model number.
  const knownMakers = new Set(
    listings.map((l) => manufacturerNeedle(l)).filter((m): m is string => m !== null),
  );

  const prepared = listings.map((listing) => ({
    listing,
    needles: needlesFor(listing, knownMakers),
    maker: manufacturerNeedle(listing),
  }));

  const out: CommentMatch[] = [];
  for (const comment of comments) {
    // Steve's own BST comments list the same gear as his listings, so every item he is selling
    // matches his own post — noise that drowns the real offers. Filtered here rather than at
    // ingest so it covers every path into the matcher, including a hand-pasted thread (PD-483).
    if (isIgnoredAuthor(comment.author)) continue;

    const doc = normalizeComment(comment.body);
    if (!doc.text) continue;

    for (const { listing, needles, maker } of prepared) {
      const hit = bestHit(doc, needles, maker);
      if (!hit) continue;
      out.push({
        listingId: listing.id,
        commentId: comment.id,
        author: comment.author,
        permalink: comment.permalink,
        intent: inferIntent(doc.text, hit.at),
        confidence: hit.confidence,
        excerpt: excerptFor(comment.body, hit.needle),
        matchedOn: hit.needle,
      });
    }
  }
  return out;
}

interface Hit {
  at: number;
  needle: string;
  confidence: BstMatchConfidence;
}

/**
 * The mention that best represents this listing in this comment: **the earliest `confirmed` one
 * if there is one, otherwise the earliest `possible` one.**
 *
 * Confidence outranks position because the two are read differently — Steve skims the possible
 * group and reads the confirmed one. Letting an early generic mention shadow a later corroborated
 * one would file a solid match under "possible" on a technicality of word order.
 */
function bestHit(doc: NormalizedComment, needles: Needle[], maker: string | null): Hit | null {
  let confirmed: Hit | null = null;
  let possible: Hit | null = null;

  for (const needle of needles) {
    const needsBacking = needle.generic || needle.derived;
    let from = 0;
    for (;;) {
      const at = findToken(doc.text, needle.text, from);
      if (at < 0) break;
      from = at + 1;

      const ok = !needsBacking || (maker !== null && corroborated(doc, at, needle.text.length, maker));
      if (ok) {
        if (!confirmed || at < confirmed.at) {
          confirmed = { at, needle: needle.text, confidence: 'confirmed' };
        }
        break; // a confirmed hit for this needle; later ones can only be worse or equal
      }
      if (!possible || at < possible.at) {
        possible = { at, needle: needle.text, confidence: 'possible' };
      }
    }
  }

  return confirmed ?? possible;
}
