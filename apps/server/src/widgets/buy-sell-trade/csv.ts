import {
  BST_CSV_COLUMNS,
  isBstListingType,
  type BstListingType,
  type CreateBstListingInput,
} from '@dashboard/shared';

// CSV parsing for the one-time Google-Sheets import (PD-437). Deliberately hand-rolled rather
// than pulling a dependency: this parses one known export, and the only non-trivial part of
// RFC-4180 it needs is quoted fields (a gear list's Notes column contains commas and newlines).

/** A parsed row plus its 1-based line number in the source, so a problem can name the row. */
export interface ParsedRow {
  line: number;
  values: Record<string, string>;
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

  // Trailing record without a final newline. `sawAny` guards against a spurious empty record
  // when the text ends cleanly on a line break.
  if (field !== '' || sawAny || row.length > 0) endRow();

  return records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Normalise a header cell for lookup: trimmed, lowercased, inner whitespace collapsed, and
 *  any trailing parenthetical dropped. That last step is not cosmetic — the real sheet's
 *  column is literally `Current Location (For my personal reference)`, so an exact match
 *  would silently never map it and the location column would import as empty.
 *
 *  The sheet's first column is a title ("Holographic b_boys's Module FS List") rather than a
 *  field, so headers that still don't resolve are ignored rather than treated as an error. */
function normalizeHeader(h: string): string {
  return h
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map header cells to listing fields, dropping columns we don't recognise. */
export function mapHeaders(header: string[]): (keyof CreateBstListingInput | null)[] {
  return header.map((h) => BST_CSV_COLUMNS[normalizeHeader(h)] ?? null);
}

/** Coerce a sheet cell to a stored value: trimmed, and empty becomes null rather than "". */
function cell(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** Accept the sheet's type column loosely — 'wts', 'WTS ', 'Wts' all mean WTS. */
function coerceType(raw: string | null): BstListingType | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  return isBstListingType(up) ? up : null;
}

export interface CsvParseOutcome {
  rows: CreateBstListingInput[];
  /** One line per rejected row, naming the row and the reason. */
  problems: string[];
}

/**
 * Turn CSV text into listing inputs.
 *
 * A row is rejected — never silently coerced — when it has no recognisable `Module` or no
 * valid `Type`, because both are load-bearing: `module` is what the scanner matches on and
 * `type` decides which section of a drafted post the row lands in. Guessing either would
 * produce a plausible-looking list that quietly misbehaves later.
 */
export function parseListingsCsv(text: string): CsvParseOutcome {
  const records = parseCsv(text);
  if (records.length === 0) return { rows: [], problems: ['empty CSV'] };

  const fields = mapHeaders(records[0]);
  if (!fields.includes('module')) {
    return { rows: [], problems: ['no "Module" column found in the header row'] };
  }

  const rows: CreateBstListingInput[] = [];
  const problems: string[] = [];

  for (let r = 1; r < records.length; r++) {
    const record = records[r];
    const line = r + 1; // 1-based, counting the header

    const draft: Partial<Record<keyof CreateBstListingInput, string | null>> = {};
    fields.forEach((field, i) => {
      if (field) draft[field] = cell(record[i]);
    });

    // A wholly blank line in the middle of a sheet export is noise, not an error.
    if (Object.values(draft).every((v) => v === null)) continue;

    const module = draft.module;
    if (!module) {
      problems.push(`row ${line}: skipped — no Module`);
      continue;
    }
    const type = coerceType(draft.type ?? null);
    if (!type) {
      problems.push(
        `row ${line} (${module}): skipped — Type is "${draft.type ?? ''}", expected WTB, WTS or WTT`,
      );
      continue;
    }

    rows.push({
      type,
      module,
      manufacturer: draft.manufacturer ?? null,
      price: draft.price ?? null,
      condition: draft.condition ?? null,
      notes: draft.notes ?? null,
      location: draft.location ?? null,
    });
  }

  return { rows, problems };
}
