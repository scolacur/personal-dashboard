import { describe, expect, it } from 'vitest';
import type { BstListing } from '@dashboard/shared';
import { pickupList } from '@dashboard/shared';
import { DEFAULT_TEMPLATES, fillTemplate, monthLabel } from './drafts';

// PD-439's renderer. The load-bearing claim in every test here is about **what may appear in a
// post**: only firm sales in the sale table, feelers hedged separately, wants in their own
// section, and nothing private anywhere.

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

const AT = Date.parse('2026-08-15T09:00:00Z');
const ctx = (listings: BstListing[], terms = 'Shipping on the buyer.') => ({ listings, terms, at: AT });

describe('fillTemplate — what belongs in a post', () => {
  const stock = [
    listing({ item: 'Maths', manufacturer: 'Make Noise', saleStatus: 'for-sale', price: '$250' }),
    listing({ item: 'Plaits', manufacturer: 'Mutable', saleStatus: 'feelers', price: '$180' }),
    listing({ item: 'Quadrax', saleStatus: 'probably-wont-sell' }),
    listing({ item: 'Rhodes', type: 'WTB', saleStatus: null, category: null }),
  ];

  it('puts only firm sales in {{items}}', () => {
    const out = fillTemplate('{{items}}', 'facebook', ctx(stock));
    expect(out).toContain('Maths');
    expect(out).not.toContain('Plaits');
    expect(out).not.toContain('Quadrax');
    expect(out).not.toContain('Rhodes');
  });

  // 23 of Steve's 38 sale-side rows are feelers. Rolling them into {{items}} would advertise
  // gear he has not agreed to sell.
  it('keeps feelers in their own section', () => {
    expect(fillTemplate('{{feelers}}', 'facebook', ctx(stock))).toContain('Plaits');
    expect(fillTemplate('{{feelers}}', 'facebook', ctx(stock))).not.toContain('Maths');
  });

  // The entire point of the status: it appears in no section of any post.
  it('never drafts probably-wont-sell anywhere', () => {
    const whole = fillTemplate(DEFAULT_TEMPLATES.reddit, 'reddit', ctx(stock));
    expect(whole).not.toContain('Quadrax');
  });

  // A want drafted as a sale is the bug that nearly shipped in PD-437.
  it('puts wants in {{wanted}} and never in the sale table', () => {
    expect(fillTemplate('{{wanted}}', 'facebook', ctx(stock))).toContain('Rhodes');
    expect(fillTemplate('{{items}}', 'facebook', ctx(stock))).not.toContain('Rhodes');
  });

  it('never leaks private notes or location into any format', () => {
    const priv = [
      listing({
        item: 'Maths',
        price: '$250',
        notes: 'og box',
        privateNotes: "paid $310, don't go below $260",
        location: 'Rack A, top row',
      }),
    ];
    for (const format of ['reddit', 'facebook', 'discord'] as const) {
      const out = fillTemplate(DEFAULT_TEMPLATES[format], format, ctx(priv));
      expect(out, format).toContain('og box');
      expect(out, format).not.toContain('$310');
      expect(out, format).not.toContain('Rack A');
    }
  });
});

describe('fillTemplate — tokens', () => {
  it('substitutes terms and month', () => {
    const out = fillTemplate('{{month}} / {{terms}}', 'facebook', ctx([], 'Ships Monday.'));
    expect(out).toBe('August 2026 / Ships Monday.');
  });

  it('replaces every occurrence of a token, not just the first', () => {
    expect(fillTemplate('{{month}} {{month}}', 'facebook', ctx([]))).toBe('August 2026 August 2026');
  });

  // Blanking it would hand back a post quietly missing its list; leaving it visible says so.
  it('leaves an unknown token alone rather than swallowing it', () => {
    expect(fillTemplate('a {{item}} b', 'facebook', ctx([]))).toBe('a {{item}} b');
  });

  it('collapses the gap an empty section leaves behind', () => {
    const out = fillTemplate('Head\n\n{{feelers}}\n\nTail', 'facebook', ctx([]));
    expect(out).toBe('Head\n\nTail');
  });
});

describe('fillTemplate — formats', () => {
  const two = [
    listing({ item: 'Maths', manufacturer: 'Make Noise', price: '$250', condition: 'Mint' }),
    listing({ item: 'Memory Man', manufacturer: 'EHX', price: '$150', category: 'Pedals' }),
  ];

  it('renders Reddit as a markdown table', () => {
    const out = fillTemplate('{{items}}', 'reddit', ctx(two));
    expect(out).toContain('| Item | Condition | Price | Notes |');
    expect(out).toContain('| Make Noise Maths | Mint | $250 |');
  });

  // A markdown table renders as noise on Facebook.
  it('renders Facebook as plain lines with no table pipes', () => {
    const out = fillTemplate('{{items}}', 'facebook', ctx(two));
    expect(out).toContain('- Make Noise Maths — $250 · Mint');
    expect(out).not.toContain('|');
  });

  // Discord has markdown but no tables.
  it('renders Discord as plain lines with bold names', () => {
    const out = fillTemplate('{{items}}', 'discord', ctx(two));
    expect(out).toContain('- **Make Noise Maths** — $250 · Mint');
    expect(out).not.toContain('| ---');
  });

  // A want is a bare name — Steve's 14 WTB rows carry no price at all — so the Reddit table
  // would be one column of content and three of whitespace.
  it('renders {{wanted}} as a list even on Reddit, where sales are a table', () => {
    const ctx2 = ctx([
      listing({ item: 'Maths', manufacturer: 'Make Noise', price: '$250' }),
      listing({ item: 'Rhodes', type: 'WTB', saleStatus: null, category: null }),
    ]);
    expect(fillTemplate('{{items}}', 'reddit', ctx2)).toContain('| Item | Condition |');
    const wanted = fillTemplate('{{wanted}}', 'reddit', ctx2);
    expect(wanted).toBe('- Rhodes');
    expect(wanted).not.toContain('|');
  });

  it('does not bold the wanted list on Reddit, matching its table', () => {
    const out = fillTemplate('{{wanted}}', 'reddit', ctx([listing({ item: 'Rhodes', type: 'WTB' })]));
    expect(out).not.toContain('**');
  });

  it('sections by category when there is more than one', () => {
    const out = fillTemplate('{{items}}', 'facebook', ctx(two));
    expect(out).toContain('Modules');
    expect(out).toContain('Pedals');
  });

  // The heading would only repeat the section's own title.
  it('omits category headings when everything is one category', () => {
    const out = fillTemplate('{{items}}', 'facebook', ctx([two[0]]));
    expect(out).not.toContain('Modules');
  });

  // "$40 | offers" would otherwise open a phantom column.
  it('escapes a pipe in a value so it cannot break the Reddit table', () => {
    const out = fillTemplate('{{items}}', 'reddit', ctx([listing({ item: 'X', price: '$40 | offers' })]));
    expect(out).toContain('$40 \\| offers');
  });

  it('renders a listing with no maker, price or condition without stray separators', () => {
    expect(fillTemplate('{{items}}', 'facebook', ctx([listing({ item: 'Thing' })]))).toBe('- Thing');
  });
});

describe('pickupList', () => {
  // Shown beside the draft so Steve can collect what he just advertised — never in the post.
  it('lists where the sellable things are, ignoring rows with no location', () => {
    expect(
      pickupList([
        listing({ item: 'Maths', location: 'Rack A' }),
        listing({ item: 'Plaits', saleStatus: 'feelers', location: 'Rack B' }),
        listing({ item: 'NoLocation' }),
        listing({ item: 'Kept', saleStatus: 'probably-wont-sell', location: 'Rack C' }),
        listing({ item: 'Rhodes', type: 'WTB', saleStatus: null, location: 'nowhere' }),
      ]),
    ).toEqual([
      { item: 'Maths', location: 'Rack A' },
      { item: 'Plaits', location: 'Rack B' },
    ]);
  });
});

describe('monthLabel', () => {
  it('names the month a post is for', () => {
    expect(monthLabel(AT)).toBe('August 2026');
  });
});
