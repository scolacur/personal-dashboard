import {
  isFirmSale,
  isSellable,
  type BstCategory,
  type BstDraftFormat,
  type BstListing,
} from '@dashboard/shared';

/**
 * Render the gear list into postable text (PD-439; the on-demand half built in PD-475).
 *
 * **No Claude involvement anywhere in this file.** These are templates, not generated prose —
 * the list is already structured, and a model would only add a way for it to be wrong. That is
 * also what makes "Generate now" cheap enough to be a button rather than a job.
 *
 * ## What may and may not appear in a post
 *
 * `privateNotes` and `location` are Steve's, never a buyer's (D-065). Nothing here reads them.
 * The UI shows locations separately, next to the draft, so he can go and find the things — but
 * they are not in the text he pastes.
 *
 * ## Why `for-sale` and `feelers` are separate sections
 *
 * Only `for-sale` is a firm sale (`isFirmSale`). Of Steve's 38 sale-side rows, 23 are feelers
 * and 5 he probably won't sell — so drafting "sellable" rows as one table would advertise 28
 * items he has not agreed to sell. Feelers get their own clearly-hedged section; probably-won't-
 * sell appears nowhere, which is the entire point of that status.
 */

/** A rendered listing line, for the plain-text formats. */
function nameOf(l: BstListing): string {
  return l.manufacturer ? `${l.manufacturer} ${l.item}` : l.item;
}

/** The trailing detail after the name: price, condition, public notes — whichever exist. */
function detailsOf(l: BstListing): string[] {
  return [l.price, l.condition, l.notes].filter((v): v is string => !!v && v.trim() !== '');
}

/** Group by category, in a stable order, skipping categories with nothing in them. Sectioning a
 *  post this way is the point of the category field — pedals and modules sell to different
 *  people reading the same thread. */
function byCategory(listings: BstListing[]): { category: string; items: BstListing[] }[] {
  const order: (BstCategory | 'Uncategorised')[] = [
    'Modules',
    'Synths',
    'Pedals',
    'Other Instruments',
    'Misc',
    'Uncategorised',
  ];
  const groups = new Map<string, BstListing[]>();
  for (const l of listings) {
    const key = l.category ?? 'Uncategorised';
    const bucket = groups.get(key);
    if (bucket) bucket.push(l);
    else groups.set(key, [l]);
  }
  return order
    .filter((c) => groups.has(c))
    .map((c) => ({ category: c, items: groups.get(c)!.sort((a, b) => a.item.localeCompare(b.item)) }));
}

function escapePipes(s: string): string {
  // A price of "$40 | offers" would otherwise create a phantom column.
  return s.replace(/\|/g, '\\|');
}

function redditTable(listings: BstListing[]): string {
  const rows = listings.map((l) => {
    const cells = [nameOf(l), l.condition ?? '', l.price ?? '', l.notes ?? ''];
    return `| ${cells.map((c) => escapePipes(c.replace(/\s+/g, ' ').trim())).join(' | ')} |`;
  });
  return ['| Item | Condition | Price | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function plainLines(listings: BstListing[], bold: (s: string) => string): string {
  return listings
    .map((l) => {
      const details = detailsOf(l);
      return `- ${bold(nameOf(l))}${details.length ? ` — ${details.join(' · ')}` : ''}`;
    })
    .join('\n');
}

/** A whole section — heading per category, then the format's own row rendering. */
function section(listings: BstListing[], format: BstDraftFormat): string {
  if (listings.length === 0) return '';
  const groups = byCategory(listings);
  // One category means the heading would just repeat the section's own title.
  const withHeadings = groups.length > 1;

  return groups
    .map(({ category, items }) => {
      const body =
        format === 'reddit'
          ? redditTable(items)
          : plainLines(items, format === 'discord' ? (s) => `**${s}**` : (s) => s);
      if (!withHeadings) return body;
      const heading =
        format === 'reddit' ? `**${category}**` : format === 'discord' ? `__${category}__` : category;
      return `${heading}\n${body}`;
    })
    .join('\n\n');
}

/** The month a post is for, e.g. "August 2026". */
export function monthLabel(at: number): string {
  return new Date(at).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export interface DraftContext {
  listings: BstListing[];
  terms: string;
  at: number;
}

/**
 * Expand a template's tokens.
 *
 * An unknown `{{token}}` is **left exactly as written** rather than blanked. If Steve mistypes
 * `{{item}}`, seeing it in the output tells him immediately; silently swallowing it would give
 * him a post that is quietly missing its list.
 */
export function fillTemplate(template: string, format: BstDraftFormat, ctx: DraftContext): string {
  const sale = ctx.listings.filter(isFirmSale);
  const feelers = ctx.listings.filter((l) => isSellable(l.type) && l.saleStatus === 'feelers');
  const wanted = ctx.listings.filter((l) => !isSellable(l.type));

  const values: Record<string, string> = {
    '{{items}}': section(sale, format),
    '{{feelers}}': section(feelers, format),
    '{{wanted}}': section(wanted, format),
    '{{terms}}': ctx.terms.trim(),
    '{{month}}': monthLabel(ctx.at),
  };

  let out = template;
  for (const [token, value] of Object.entries(values)) {
    out = out.split(token).join(value);
  }
  // Collapse the runs of blank lines an empty section leaves behind, so a post with no feelers
  // does not open with a gap where they would have been.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** The seeded defaults. Editable in the app — these are a starting point, not the format. */
export const DEFAULT_TEMPLATES: Record<BstDraftFormat, string> = {
  reddit: `**WTS — {{month}}**

{{items}}

**Open to offers**

{{feelers}}

**WTB**

{{wanted}}

---

{{terms}}`,

  facebook: `FOR SALE — {{month}}

{{items}}

OPEN TO OFFERS

{{feelers}}

LOOKING FOR

{{wanted}}

{{terms}}`,

  // Discord has markdown but no tables, so this is the plain shape with Discord's emphasis.
  discord: `**For sale — {{month}}**

{{items}}

**Open to offers**

{{feelers}}

**Looking for**

{{wanted}}

{{terms}}`,
};
