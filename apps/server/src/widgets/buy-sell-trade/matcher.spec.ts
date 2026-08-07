import { describe, expect, it } from 'vitest';
import type { BstCommentInput, BstListing } from '@dashboard/shared';
import {
  coreName,
  excerptFor,
  inferIntent,
  isGeneric,
  matchComments,
  needlesFor,
  normalize,
  normalizeComment,
} from './matcher';

// PD-438, retuned by PD-475. The trade these tests are written against is **recall, with the
// uncertainty labelled**: nothing is discarded, and a mention the matcher cannot vouch for comes
// back as `possible` rather than as silence.
//
// So the shape of an assertion here is almost never "did it match" — it is "at what confidence".
// A test expecting `[]` is claiming the text does not mention the item *at all*; a test expecting
// `possible` is claiming it might. Those say different things, and a change that collapses the
// second into the first is the regression D-065's amendment exists to prevent.

let nextId = 1;
function listing(over: Partial<BstListing> & { item: string }): BstListing {
  return {
    id: nextId++,
    type: 'WTS',
    manufacturer: null,
    price: null,
    condition: null,
    notes: null,
    privateNotes: null,
    location: null,
    saleStatus: 'for-sale',
    category: 'Modules',
    aliases: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** `[matchedOn, confidence]` for each match — what almost every assertion below is about. */
function found(out: ReturnType<typeof matchComments>): string[][] {
  return out.map((m) => [m.matchedOn, m.confidence]);
}

function comment(body: string, over: Partial<BstCommentInput> = {}): BstCommentInput {
  return {
    id: over.id ?? `c${nextId++}`,
    author: over.author ?? 'someone',
    permalink: over.permalink ?? 'https://reddit.com/r/modular/comments/x/_/c1',
    body,
  };
}

describe('normalize', () => {
  it('folds case, punctuation and whitespace to a token stream', () => {
    expect(normalize('  Ultra-Perc  (SSF) ')).toBe('ultra perc ssf');
  });

  it('removes apostrophes rather than splitting on them, so Pam’s folds to pams', () => {
    expect(normalize("Pam's")).toBe('pams');
    expect(normalize('Pam’s')).toBe('pams');
  });

  // Two of Steve's items are Cyrillic. Transliterating or stripping "diacritics" would destroy
  // them; lowercasing is all they need.
  it('preserves Cyrillic and only lowercases it', () => {
    expect(normalize('Пуск-3')).toBe('пуск 3');
    expect(normalize('СЛИМИКС 6 Channel')).toBe(
      'слимикс 6 channel',
    );
  });
});

describe('coreName', () => {
  it('drops a trailing variant parenthetical — people type the name, not the colour', () => {
    expect(coreName('hrylo (gold)')).toBe('hrylo');
    expect(coreName('Loop (Silver)')).toBe('loop');
  });

  it('keeps the parenthetical when it is the whole name', () => {
    expect(coreName('(gold)')).toBe('gold');
  });
});

describe('isGeneric', () => {
  it('flags ordinary modular vocabulary', () => {
    for (const t of ['mix', 'vca', 'loop', 'slice', 'filter', 'case']) {
      expect(isGeneric(t)).toBe(true);
    }
  });

  it('flags very short names — "qua" collides with too much', () => {
    expect(isGeneric('qua')).toBe(true);
  });

  it('does not flag a distinctive single word or any multi-word name', () => {
    expect(isGeneric('chronoblob')).toBe(false);
    expect(isGeneric('optx')).toBe(false);
    expect(isGeneric('ultra perc')).toBe(false);
  });
});

describe('matchComments — confidence', () => {
  it('matches a distinctive name on a word boundary, confirmed', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob', manufacturer: 'Alright Devices' })],
      [comment('WTS Chronoblob $250, mint')],
    );
    expect(found(out)).toEqual([['chronoblob', 'confirmed']]);
  });

  // Still the one hard "no". Whole-token matching is what separates "does not mention it" from
  // "might mention it", and without it every `possible` would be noise.
  it('does NOT match a distinctive name inside a longer word', () => {
    const out = matchComments(
      [listing({ item: 'Plaits', manufacturer: 'Mutable' })],
      [comment('anyone tried replaitsing the firmware')],
    );
    expect(out).toEqual([]);
  });

  // The defining case, and the one PD-475 reversed. Steve has a module literally called "Mix".
  // PD-438 recorded nothing here; the cost was that a real "Mix" sale was indistinguishable from
  // no sale. It is now recorded, and labelled as the guess it is.
  it('records a generic name on its own as possible, not as silence', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: Doepfer A-138 mix, $40 shipped')],
    );
    expect(found(out)).toEqual([['mix', 'possible']]);
  });

  it('confirms a generic name when the manufacturer is right next to it', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: 2hp Mix $60 shipped')],
    );
    expect(found(out)).toEqual([['mix', 'confirmed']]);
  });

  it('accepts the manufacturer on either side of the name', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: Mix (2hp), barely used')],
    );
    expect(found(out)).toEqual([['mix', 'confirmed']]);
  });

  // Corroboration is per line item (PD-475 A2), so a maker in a *different* bullet cannot vouch
  // for this one. The hit is still recorded — just not as a confirmed one.
  it('does not let a manufacturer from another line item confirm a generic name', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [
        comment(
          'WTS:\n- 2hp Verb, excellent condition, original box, asking sixty dollars\n' +
            '- Doepfer A-138 passive mix, forty dollars',
        ),
      ],
    );
    expect(found(out)).toEqual([['mix', 'possible']]);
  });

  // The line item is the boundary, so a maker at the far end of a long one still corroborates —
  // this is the case PD-438's flat ±40 characters got wrong.
  it('confirms across a long single line item, where the old character window could not reach', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: 2hp Mix, original box and ribbon cable included, barely used — $60 shipped')],
    );
    expect(found(out)).toEqual([['mix', 'confirmed']]);
  });

  // Without a cap, a comment written as one unbroken paragraph would make every maker in it
  // vouch for every name in it.
  it('will not corroborate across a wall of text with no line breaks', () => {
    const filler = 'and various other bits and pieces from the rack i am clearing out this month';
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment(`WTS 2hp Verb ${filler} ${filler} plus a Doepfer A-138 mix for forty dollars`)],
    );
    expect(found(out)).toEqual([['mix', 'possible']]);
  });

  // PD-438 could not record this at all: generic name, no manufacturer to corroborate with. It
  // was the clearest example of the recall cost, and it is now a possible match.
  it('records a generic name with no manufacturer at all as possible', () => {
    const out = matchComments(
      [listing({ item: 'Slice', manufacturer: null })],
      [comment('WTS Slice, $115')],
    );
    expect(found(out)).toEqual([['slice', 'possible']]);
  });

  it('matches a multi-word name without needing the manufacturer', () => {
    const out = matchComments(
      [listing({ item: 'Ultra Perc', manufacturer: null })],
      [comment('selling an ultra perc, $380')],
    );
    expect(found(out)).toEqual([['ultra perc', 'confirmed']]);
  });

  // Confidence outranks position: the corroborated mention is the one worth showing, even though
  // an uncorroborated one came first.
  it('prefers a later confirmed mention over an earlier possible one', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTB a mix of some kind\nWTS: 2hp Mix $60')],
    );
    expect(found(out)).toEqual([['mix', 'confirmed']]);
    // …and the intent comes from the mention that won, not from the first one in the comment.
    expect(out[0].intent).toBe('WTS');
  });

  it('matches a name that appears with a version suffix', () => {
    const out = matchComments([listing({ item: 'Maths' })], [comment('WTS Maths v2, $250')]);
    expect(out).toHaveLength(1);
  });

  it('matches a curated alias, including a short one', () => {
    const out = matchComments(
      [listing({ item: "Pamela's PRO Workout", manufacturer: 'ALM' })],
      [comment('WTS PPW $180')],
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedOn).toBe('ppw');
  });

  it("matches a possessive alias — Pam's and Pamela's are the same module", () => {
    const out = matchComments(
      [listing({ item: "Pamela's PRO Workout", manufacturer: 'ALM' })],
      [comment("WTS Pam's Pro Workout, mint")],
    );
    expect(out).toHaveLength(1);
  });

  it('matches a Cyrillic name written with a hyphen or a space', () => {
    const l = [listing({ item: 'Пуск-3', manufacturer: 'Paratek' })];
    expect(matchComments(l, [comment('WTS Пуск-3 $80')])).toHaveLength(1);
    expect(matchComments(l, [comment('WTS Пуск 3 $80')])).toHaveLength(1);
  });

  it('records one match per (listing, comment) even when the item is named repeatedly', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob' })],
      [comment('WTS Chronoblob. The Chronoblob is mint. Chronoblob has its box.')],
    );
    expect(out).toHaveLength(1);
  });

  it('matches every listing a single comment mentions', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob' }), listing({ item: 'Quadigy' })],
      [comment('WTS Chronoblob $250 and Quadigy $200')],
    );
    expect(out.map((m) => m.matchedOn).sort()).toEqual(['chronoblob', 'quadigy']);
  });

  it('ignores an empty comment body rather than matching everything', () => {
    expect(matchComments([listing({ item: 'Chronoblob' })], [comment('   ')])).toEqual([]);
  });
});

// PD-475 A3. The curated table cannot know what Steve calls his own gear; the listing can.
describe('per-listing aliases', () => {
  it('matches an alias Steve wrote on the listing', () => {
    const out = matchComments(
      [listing({ item: 'A-111-5 Mini Synth Voice', manufacturer: 'Doepfer', aliases: 'A-111-5' })],
      [comment('WTS a-111-5, $90')],
    );
    expect(found(out)).toEqual([['a 111 5', 'confirmed']]);
  });

  it('merges with the curated defaults rather than replacing them', () => {
    const l = listing({
      item: "Pamela's PRO Workout",
      manufacturer: 'ALM',
      aliases: 'the pam, workout module',
    });
    // Curated (`ppw`) and per-listing (`the pam`) both survive the merge.
    expect(found(matchComments([l], [comment('WTS PPW $180')]))).toEqual([['ppw', 'confirmed']]);
    expect(found(matchComments([l], [comment('WTS the pam $180')]))).toEqual([
      ['the pam', 'confirmed'],
    ]);
  });

  it('takes a comma-separated list, trimming and ignoring blanks', () => {
    const n = needlesFor(listing({ item: 'Quadrax', aliases: ' qx ,, quad rax ' }));
    expect(n.map((x) => x.text)).toContain('qx');
    expect(n.map((x) => x.text)).toContain('quad rax');
  });

  // A human writing "mix" in the aliases box cannot make the word distinctive — the whole
  // thread is full of it. Trusted, but still needs backing.
  it('does not let a hand-written alias override ordinary modular vocabulary', () => {
    const out = matchComments(
      [listing({ item: 'СЛИМИКС', manufacturer: 'Paratek', aliases: 'mix' })],
      [comment('WTS: Doepfer A-138 mix, $40')],
    );
    expect(found(out)).toEqual([['mix', 'possible']]);
  });
});

// PD-475 A4. People name gear by model number or short name with the manufacturer dropped.
// Every derivation here is a guess, so every one of them is `possible` unless the maker is
// sitting next to it.
describe('derived aliases', () => {
  it('derives a leading model number', () => {
    const out = matchComments(
      [listing({ item: 'A-111-5 Mini Synth Voice', manufacturer: 'Doepfer' })],
      [comment('WTS a-111-5, $90')],
    );
    expect(found(out)).toEqual([['a 111 5', 'possible']]);
  });

  it('confirms a derived alias when the manufacturer backs it up', () => {
    const out = matchComments(
      [listing({ item: 'A-111-5 Mini Synth Voice', manufacturer: 'Doepfer' })],
      [comment('WTS Doepfer A-111-5, $90')],
    );
    expect(found(out)).toEqual([['a 111 5', 'confirmed']]);
  });

  // "2hp Mix" begins with the manufacturer, not a model number. Deriving "2hp" as an alias for
  // `Mix` would fire on every 2hp module in the thread.
  it('does not mistake a leading manufacturer for a model number', () => {
    const texts = needlesFor(listing({ item: '2hp Mix', manufacturer: '2hp' })).map((n) => n.text);
    expect(texts).not.toContain('2 hp');
  });

  it('drops a trailing product-category word and a trailing "with" clause', () => {
    const texts = needlesFor(
      listing({ item: 'Memory Man with Hazarai Pedal', manufacturer: 'Electro-Harmonix' }),
    ).map((n) => n.text);
    expect(texts).toContain('memory man with hazarai');
    expect(texts).toContain('memory man');
  });

  it('drops a manufacturer repeated inside the item name', () => {
    const out = matchComments(
      [listing({ item: 'Make Noise Maths', manufacturer: 'Make Noise' })],
      [comment('WTS maths, $250')],
    );
    expect(found(out)).toEqual([['maths', 'possible']]);
  });

  it('does not derive a fragment too short to mean anything', () => {
    const texts = needlesFor(listing({ item: 'Doepfer A-1 Module', manufacturer: 'Doepfer' })).map(
      (n) => n.text,
    );
    expect(texts).not.toContain('a 1');
  });
});

// PD-475 A5. Steve asked whether these work; the answers are pinned here rather than asserted
// in a conversation.
describe('the cases Steve asked about', () => {
  it('ignores capitalisation, apostrophes, punctuation and hyphens', () => {
    const l = [listing({ item: "Pamela's NEW Workout", manufacturer: 'ALM' })];
    for (const body of [
      "WTS Pamela's New Workout",
      'WTS PAMELAS NEW WORKOUT',
      'WTS pamelas-new-workout',
      'WTS "Pamela’s New Workout."',
    ]) {
      expect(matchComments(l, [comment(body)]), body).toHaveLength(1);
    }
  });

  it('matches a nickname-only mention', () => {
    const out = matchComments(
      [listing({ item: "Pamela's PRO Workout", manufacturer: 'ALM' })],
      [comment('anyone selling a pams pro workout?')],
    );
    expect(found(out)).toEqual([['pams pro workout', 'confirmed']]);
  });

  it('matches a model-number-only mention', () => {
    const out = matchComments(
      [listing({ item: 'A-111-5 Mini Synth Voice', manufacturer: 'Doepfer', aliases: 'A-111-5' })],
      [comment('WTB A111-5')],
    );
    expect(out).toHaveLength(1);
  });

  it('matches when the manufacturer is left out of a well-known item', () => {
    const out = matchComments(
      [listing({ item: 'Maths', manufacturer: 'Make Noise' })],
      [comment('WTS Maths, $250 shipped')],
    );
    expect(found(out)).toEqual([['maths', 'confirmed']]);
  });
});

describe('normalizeComment', () => {
  it('records one span per line item, skipping blank lines', () => {
    const doc = normalizeComment('WTS:\n\n- 2hp Mix\n- Doepfer A-138');
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines.map((l) => doc.text.slice(l.start, l.end))).toEqual([
      'wts',
      '2hp mix',
      'doepfer a 138',
    ]);
  });

  it('splits on bullet characters as well as newlines', () => {
    const doc = normalizeComment('WTS • 2hp Mix • Doepfer A-138');
    expect(doc.lines).toHaveLength(3);
  });

  // A markdown table is a *well-formatted* BST comment. Splitting on the column separator would
  // put the maker in a different line item from the module it describes.
  it('does not split a markdown table row into cells', () => {
    const doc = normalizeComment('| 2hp | Mix | $60 |');
    expect(doc.lines).toHaveLength(1);
  });
});

describe('inferIntent', () => {
  const at = (text: string, needle: string): number =>
    ` ${normalize(text)} `.indexOf(` ${needle} `);

  it('reads the marker that precedes the mention', () => {
    const text = normalize('WTS Chronoblob $250');
    expect(inferIntent(text, at('WTS Chronoblob $250', 'chronoblob'))).toBe('WTS');
  });

  // The reason intent is positional rather than a comment-wide vote. A single BST comment
  // routinely carries both halves, and labelling the WTB line "selling" is exactly the kind of
  // confident wrongness this feature cannot afford.
  it('uses the NEAREST preceding marker in a two-section comment', () => {
    const raw = 'WTS: Chronoblob $250, Quadigy $200\nWTB: Quadrax, Maths';
    const text = normalize(raw);
    expect(inferIntent(text, at(raw, 'chronoblob'))).toBe('WTS');
    expect(inferIntent(text, at(raw, 'quadrax'))).toBe('WTB');
  });

  it('falls back to the comment-wide marker when the mention comes first', () => {
    const raw = 'Chronoblob, $250 — for sale, shipped conus';
    expect(inferIntent(normalize(raw), at(raw, 'chronoblob'))).toBe('WTS');
  });

  it('records unknown when the comment carries no marker at all', () => {
    const raw = 'I love my Chronoblob, best delay ever';
    expect(inferIntent(normalize(raw), at(raw, 'chronoblob'))).toBe('unknown');
  });

  it('records unknown when the mention precedes conflicting markers', () => {
    const raw = 'Chronoblob\nWTS: Maths\nWTB: Quadrax';
    expect(inferIntent(normalize(raw), at(raw, 'chronoblob'))).toBe('unknown');
  });

  it('reads the common abbreviations', () => {
    const cases: [string, string][] = [
      ['FS: Chronoblob', 'WTS'],
      ['ISO Chronoblob', 'WTB'],
      ['WTT Chronoblob', 'WTT'],
      ['looking for a Chronoblob', 'WTB'],
      ['in search of a Chronoblob', 'WTB'],
    ];
    for (const [raw, expected] of cases) {
      expect(inferIntent(normalize(raw), at(raw, 'chronoblob'))).toBe(expected);
    }
  });
});

describe('matchComments — intent on the match', () => {
  it('carries the positional intent onto each match', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob' }), listing({ item: 'Quadrax' })],
      [comment('WTS: Chronoblob $250\nWTB: Quadrax')],
    );
    const byName = Object.fromEntries(out.map((m) => [m.matchedOn, m.intent]));
    expect(byName).toEqual({ chronoblob: 'WTS', quadrax: 'WTB' });
  });

  it('prefers unknown over a guess', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob' })],
      [comment('does anyone still make the Chronoblob?')],
    );
    expect(out[0].intent).toBe('unknown');
  });
});

describe('excerptFor', () => {
  it('keeps the original casing and punctuation Steve would want to read', () => {
    expect(excerptFor('WTS: Chronoblob — $250 shipped, og box', 'chronoblob')).toContain(
      '$250 shipped',
    );
  });

  it('collapses newlines so the readout stays one line per match', () => {
    expect(excerptFor('WTS:\n\n  Chronoblob\n  $250', 'chronoblob')).not.toMatch(/\n/);
  });

  it('ellipsises a long comment around the mention', () => {
    const body = `${'x '.repeat(200)}Chronoblob${' y'.repeat(200)}`;
    const out = excerptFor(body, 'chronoblob');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('Chronoblob');
  });
});

// Found by running the matcher against Steve's real 52 listings (2026-08-07), not by fixtures:
// one WTB row produced ~8 of 39 possible matches on its own.
describe('a leading manufacturer is never derived as a model number', () => {
  const rout = listing({ item: '2hp Rout', manufacturer: null }); // as it really is on his list
  const mix = listing({ item: 'Mix', manufacturer: '2hp' }); // …and 2hp IS a maker on another row

  it('does not derive "2hp" from a row that records no manufacturer of its own', () => {
    // Alone, the row has no way to know 2hp is a brand — this is the buggy case.
    expect(needlesFor(rout).map((n) => n.text)).toContain('2hp');
    // Given the list's manufacturer vocabulary, it does.
    const makers = new Set(['2hp']);
    expect(needlesFor(rout, makers).map((n) => n.text)).not.toContain('2hp');
  });

  it('stops that row matching every 2hp module in a thread', () => {
    const comment2hp = comment('WTS: 2hp Verb $60, 2hp Tune $55, Doepfer A-138 $40');
    // matchComments builds the vocabulary from the whole list, so Rout must not fire here.
    const out = matchComments([rout, mix], [comment2hp]);
    expect(out.filter((m) => m.listingId === rout.id)).toEqual([]);
  });

  it('still derives a genuine model number that is not anyone’s maker', () => {
    const l = listing({ item: 'A-111-5 Mini Synth Voice', manufacturer: 'Doepfer' });
    expect(needlesFor(l, new Set(['2hp', 'doepfer'])).map((n) => n.text)).toContain('a 111 5');
  });
});
