import { describe, expect, it } from 'vitest';
import type { BstCommentInput, BstListing } from '@dashboard/shared';
import { coreName, excerptFor, inferIntent, isGeneric, matchComments, normalize } from './matcher';

// PD-438. Every test here is written against the same trade: **precision over recall**. The
// scan runs weekly and Steve reads the output, so a false match costs him attention every week
// while a miss costs him one trade. Where a case is genuinely ambiguous the expectation is that
// the matcher declines — and the tests below say so out loud, because a future change that
// "fixes" a missing match by loosening the rules would be a regression, not an improvement.

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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
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

describe('matchComments — the precision cases', () => {
  it('matches a distinctive name on a word boundary', () => {
    const out = matchComments(
      [listing({ item: 'Chronoblob', manufacturer: 'Alright Devices' })],
      [comment('WTS Chronoblob $250, mint')],
    );
    expect(out).toHaveLength(1);
    expect(out[0].matchedOn).toBe('chronoblob');
  });

  it('does NOT match a distinctive name inside a longer word', () => {
    const out = matchComments(
      [listing({ item: 'Plaits', manufacturer: 'Mutable' })],
      [comment('anyone tried replaitsing the firmware')],
    );
    expect(out).toEqual([]);
  });

  // The defining case for this feature. Steve has a module literally called "Mix". A substring
  // or bare word-boundary match flags most comments in a BST thread.
  it('does NOT match a generic name on its own', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: Doepfer A-138 mix, $40 shipped')],
    );
    expect(out).toEqual([]);
  });

  it('DOES match a generic name when the manufacturer is right next to it', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: 2hp Mix $60 shipped')],
    );
    expect(out).toHaveLength(1);
  });

  it('accepts the manufacturer on either side of the name', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [comment('WTS: Mix (2hp), barely used')],
    );
    expect(out).toHaveLength(1);
  });

  // The corroboration window is sized so a maker mentioned in a *different* line item cannot
  // vouch for this one. Without this, any comment listing several 2hp modules would match "Mix".
  it('does not accept a manufacturer from a distant line of the same comment', () => {
    const out = matchComments(
      [listing({ item: 'Mix', manufacturer: '2hp' })],
      [
        comment(
          'WTS:\n- 2hp Verb, excellent condition, original box, asking sixty dollars\n' +
            '- Doepfer A-138 passive mix, forty dollars',
        ),
      ],
    );
    expect(out).toEqual([]);
  });

  // The precision trade stated as an outcome: this loses a real match rather than risk a
  // weekly false one. If this test ever "fails" because someone made it match, read the
  // module docblock before changing it.
  it('never matches a generic name when the listing has no manufacturer to corroborate with', () => {
    const out = matchComments(
      [listing({ item: 'Slice', manufacturer: null })],
      [comment('WTS Slice, $115')],
    );
    expect(out).toEqual([]);
  });

  it('matches a multi-word name without needing the manufacturer', () => {
    const out = matchComments(
      [listing({ item: 'Ultra Perc', manufacturer: null })],
      [comment('selling an ultra perc, $380')],
    );
    expect(out).toHaveLength(1);
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
