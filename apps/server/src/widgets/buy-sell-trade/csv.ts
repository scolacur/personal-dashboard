import {
  BST_CSV_COLUMNS,
  isBstListingType,
  type BstCategory,
  type BstListingType,
  type BstSaleStatus,
  type CreateBstListingInput,
} from '@dashboard/shared';

// CSV import for the Buy/Sell/Trade gear list (PD-437). Deliberately hand-rolled rather than
// pulling a dependency: it parses one known export, and the only non-trivial part of RFC-4180
// it needs is quoted fields (the Notes column contains commas).
//
// The source sheet is NOT a flat table, and the first version of this importer — which assumed
// it was — rejected all 46 rows. Its real shape:
//
//   col 1  "Holographic b_boys's Module FS List"  free prose: the sale terms, then, below a
//                                                 "WTTF:" marker, a want-to-trade-for list
//   col 2  "Type"                                 a SECTION marker (MODULES / MISC / Feelers /
//                                                 Probably won't sell) that applies DOWNWARD
//                                                 until the next one — not WTB/WTS/WTT
//   col 3+ Manufacturer, Module, Price, ...       the actual listing
//
// So one row can carry a terms line, a section change, and a listing simultaneously, and each
// is extracted independently.

/** Marks the start of the want-to-trade-for list in column 1. Everything above is terms. */
const WANT_LIST_MARKER = /^WTTF\b/i;

/** Sub-headings inside the want list that are not themselves wanted items. Sheet-specific;
 *  kept as an explicit list so an unexpected heading shows up as a bogus want rather than
 *  being silently swallowed by a clever heuristic. */
const WANT_SUBHEADINGS = new Set(['non-modular', 'modular']);

/** The sheet is a *For Sale* list: a module row with no explicit WTB/WTS/WTT is for sale. */
const DEFAULT_LISTING_TYPE: BstListingType = 'WTS';

/**
 * The sheet's running section markers, split into the two ideas they conflate: willingness
 * to sell, and category.
 *
 * A willingness marker (`Feelers`, `Probably won't sell`) says nothing about category, so it
 * resets to `Modules` — the overwhelming default — rather than carrying the previous category
 * forward, which would silently label 22 modules `Misc` because one `MISC` row preceded them.
 * Anything mis-categorised is one dropdown away in the UI.
 */
const SECTION_MARKERS: Record<string, { status: BstSaleStatus; category: BstCategory }> = {
  modules: { status: 'for-sale', category: 'Modules' },
  misc: { status: 'for-sale', category: 'Misc' },
  feelers: { status: 'feelers', category: 'Modules' },
  "probably won't sell": { status: 'probably-wont-sell', category: 'Modules' },
};

/** Curly apostrophes and casing vary in a hand-maintained sheet; normalise before lookup. */
function normalizeMarker(s: string): string {
  return s.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

/**
 * Repair UTF-8 text that was decoded as Latin-1 ("mojibake") — the sheet's Cyrillic module
 * names arrive as `Ð¡Ð\x9bÐ\x98...` when the export is mis-encoded. Round-trips the bytes back
 * through UTF-8.
 *
 * This matters beyond cosmetics: the r/modular scanner (PD-438) matches on module name, so a
 * mangled name can never match a comment.
 *
 * Guarded twice — it only touches strings carrying a mojibake signature, and only keeps the
 * result if it decodes cleanly (no U+FFFD). Correct text is returned untouched.
 */
export function repairMojibake(s: string): string {
  if (!/[ÃÂÐÑ]/.test(s)) return s;
  try {
    const repaired = Buffer.from(s, 'latin1').toString('utf8');
    return repaired.includes('�') ? s : repaired;
  } catch {
    return s;
  }
}

/**
 * Split CSV text into records. Handles quoted fields, embedded commas and newlines inside
 * quotes, and escaped double-quotes (`""`). Bare CR and CRLF both terminate a record.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    sawAny = true;
  };
  const endRow = (): void => {
    endField();
    records.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
    }
  }

  if (field !== '' || sawAny || row.length > 0) endRow();

  return records;
}

/** Normalise a header cell for lookup: trimmed, lowercased, inner whitespace collapsed, and
 *  any trailing parenthetical dropped. That last step is not cosmetic — the real sheet's
 *  column is literally `Current Location (For my personal reference)`, so an exact match
 *  would silently never map it and every location would import as empty. */
function normalizeHeader(h: string): string {
  return h
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map header cells to listing fields, dropping columns we don't recognise (the sheet's first
 *  column is a prose column titled with the list's name, not a field). */
export function mapHeaders(header: string[]): (keyof CreateBstListingInput | null)[] {
  return header.map((h) => BST_CSV_COLUMNS[normalizeHeader(h)] ?? null);
}

/** Coerce a sheet cell to a stored value: mojibake-repaired, trimmed, and empty becomes null
 *  rather than "". */
function cell(v: string | undefined): string | null {
  const t = repairMojibake(v ?? '').trim();
  return t === '' ? null : t;
}

/** Accept an explicit type loosely — 'wts', 'WTS ', 'Wts' all mean WTS. Anything else (the
 *  section markers) is not a type. */
function asListingType(raw: string | null): BstListingType | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  return isBstListingType(up) ? up : null;
}

export interface SheetParseOutcome {
  rows: CreateBstListingInput[];
  /** Prose above the WTTF marker in column 1, joined with newlines. */
  terms: string | null;
  problems: string[];
}

/**
 * Turn the sheet's CSV into listing inputs, extracted terms, and problems.
 *
 * Produces two kinds of row:
 *  - **module rows** (columns 3+) → `WTS` by default, carrying the section marker in force;
 *  - **want-list entries** (column 1, below the WTTF marker) → `WTT` with only a module name.
 *
 * A module row is rejected — never silently coerced — only when it has no module name, since
 * that is what the scanner matches on. An unrecognised value in the Type column is a *section*,
 * not an error.
 */
export function parseSheetCsv(text: string): SheetParseOutcome {
  const records = parseCsv(text).filter((r) => r.length > 0);
  if (records.length === 0) return { rows: [], terms: null, problems: ['empty CSV'] };

  const fields = mapHeaders(records[0]);
  const moduleCol = fields.indexOf('module');
  if (moduleCol === -1) {
    return { rows: [], terms: null, problems: ['no "Module" column found in the header row'] };
  }

  // Column 1 is a prose column when its header maps to no field — the real sheet's case.
  const proseCol = fields[0] === null ? 0 : -1;

  const rows: CreateBstListingInput[] = [];
  const problems: string[] = [];
  const termsLines: string[] = [];
  const wants: { name: string; line: number }[] = [];

  let saleStatus: BstSaleStatus = 'for-sale';
  let category: BstCategory = 'Modules';
  let inWantList = false;

  for (let r = 1; r < records.length; r++) {
    const record = records[r];
    const line = r + 1; // 1-based, counting the header

    // 1. Column-1 prose: terms above the WTTF marker, wanted items below it.
    if (proseCol >= 0) {
      const prose = cell(record[proseCol]);
      if (prose) {
        if (WANT_LIST_MARKER.test(prose)) {
          inWantList = true;
        } else if (!inWantList) {
          termsLines.push(prose);
        } else if (!WANT_SUBHEADINGS.has(prose.toLowerCase()) && !prose.endsWith(':')) {
          wants.push({ name: prose, line });
        }
      }
    }

    // 2. Section marker: a Type-column value that isn't a listing type starts a new section
    //    and stays in force until the next one.
    const draft: Partial<Record<keyof CreateBstListingInput, string | null>> = {};
    fields.forEach((field, i) => {
      if (field) draft[field] = cell(record[i]);
    });

    const explicitType = asListingType(draft.type ?? null);
    if (!explicitType && draft.type) {
      const marker = SECTION_MARKERS[normalizeMarker(draft.type)];
      if (marker) {
        saleStatus = marker.status;
        category = marker.category;
      } else {
        // Visible rather than silently ignored: an unknown marker means the sheet grew a
        // section this importer doesn't know, and everything below it inherits the old one.
        problems.push(`row ${line}: unrecognised section "${draft.type}" — rows below keep "${saleStatus}"`);
      }
    }

    // 3. Listing row.
    const module = draft.module;
    if (!module) continue; // prose-only or spacer row — not an error

    rows.push({
      type: explicitType ?? DEFAULT_LISTING_TYPE,
      module,
      manufacturer: draft.manufacturer ?? null,
      price: draft.price ?? null,
      condition: draft.condition ?? null,
      notes: draft.notes ?? null,
      location: draft.location ?? null,
      // Sale status and category describe an offering; they are meaningless on a want row.
      saleStatus: explicitType && explicitType !== 'WTS' ? null : saleStatus,
      category: explicitType && explicitType !== 'WTS' ? null : category,
    });
  }

  // Want-list entries carry only a name — no manufacturer, price or condition to import, and
  // no sale status or category, since Steve is not the one offering them.
  for (const w of wants) {
    rows.push({
      type: 'WTT',
      module: w.name,
      manufacturer: null,
      price: null,
      condition: null,
      notes: null,
      location: null,
      saleStatus: null,
      category: null,
    });
  }

  if (rows.length === 0) problems.push('no rows with a Module were found');

  return {
    rows,
    terms: termsLines.length > 0 ? termsLines.join('\n') : null,
    problems,
  };
}
