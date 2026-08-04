// Pure logic behind ListManager.svelte (PD-441) — filtering, sorting, and draft
// validation for any user-managed list. Kept out of the component so it is unit-testable
// without mounting anything, the same split as timer-logic.ts and layout.ts.

/** The input controls a field descriptor can ask for. */
export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'date';

/** A single field on the record type a list manages. Drives BOTH the add/edit form and
 *  the list columns, so a new list is a field array plus handlers — nothing more. */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Choices for `select`. Ignored for every other type. */
  options?: readonly string[];
  required?: boolean;
  placeholder?: string;
  /** Small grey note under the input. */
  hint?: string;
  /** In the form but not a list column — for long text that would wreck the table. */
  formOnly?: boolean;
}

/** What a form control produces. `null` means "left empty". */
export type FieldValue = string | number | null;

/** An in-progress add/edit form, keyed by field key. */
export type Draft = Record<string, FieldValue>;

/** The minimum a managed record must be: a bag of readable properties. */
export type ListItem = Record<string, unknown>;

export type SortDir = 'asc' | 'desc';

/** Empty for sort/validation purposes: null, undefined, or a blank/whitespace string.
 *  `0` and `false` are values, not emptiness — a price of 0 must sort as a number. */
function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Render any value as display/search text. Arrays join so tag-style fields stay searchable. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/* ── Drafts ─────────────────────────────────────── */

/** A blank draft for the "add" case: every field present and empty, so the form is
 *  fully controlled from the first render. */
export function emptyDraft(fields: FieldDef[]): Draft {
  const draft: Draft = {};
  for (const f of fields) draft[f.key] = null;
  return draft;
}

/** A draft seeded from an existing record for the "edit" case. Values the record does not
 *  carry come back empty rather than undefined. */
export function toDraft(item: ListItem, fields: FieldDef[]): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    const raw = item[f.key];
    if (isEmpty(raw)) {
      draft[f.key] = null;
    } else if (f.type === 'number') {
      const n = Number(raw);
      draft[f.key] = Number.isFinite(n) ? n : null;
    } else {
      draft[f.key] = formatValue(raw);
    }
  }
  return draft;
}

/** Coerce a raw control value into what the field's type stores. A number field yields a
 *  number (or null when blank/unparseable) so callers never receive numeric strings. */
export function coerceValue(field: FieldDef, raw: string): FieldValue {
  if (raw === '') return null;
  if (field.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw;
}

/** Validation errors keyed by field key; an empty object means the draft is submittable.
 *  Only two rules — required-ness and number-parseability — because anything richer belongs
 *  to the caller's own domain, not to a generic list. */
export function validateDraft(fields: FieldDef[], draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = draft[f.key];
    if (f.required && isEmpty(v)) {
      errors[f.key] = `${f.label} is required.`;
      continue;
    }
    if (f.type === 'number' && v !== null && v !== undefined && typeof v !== 'number') {
      errors[f.key] = `${f.label} must be a number.`;
    }
  }
  return errors;
}

/** Strip empty values so a submitted draft carries only what was actually filled in. */
export function cleanDraft(draft: Draft): Draft {
  const out: Draft = {};
  for (const [k, v] of Object.entries(draft)) {
    if (!isEmpty(v)) out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/* ── Filtering ──────────────────────────────────── */

/** Case-insensitive substring match across `keys`. A blank query matches everything, so
 *  the list is never empty just because the box has focus. */
export function matchesQuery(item: ListItem, query: string, keys: string[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return keys.some((k) => formatValue(item[k]).toLowerCase().includes(q));
}

export function filterItems<T extends ListItem>(items: T[], query: string, keys: string[]): T[] {
  if (query.trim() === '') return [...items];
  return items.filter((i) => matchesQuery(i, query, keys));
}

/* ── Sorting ────────────────────────────────────── */

/** Compare two field values. Numbers compare numerically, everything else compares as
 *  case-insensitive text. Empty values sort last — see sortItems for why that survives desc. */
export function compareValues(a: unknown, b: unknown): number {
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof a === 'number' && typeof b === 'number') return a - b;

  const as = formatValue(a).toLowerCase();
  const bs = formatValue(b).toLowerCase();
  return as.localeCompare(bs);
}

/** Sort a copy of `items` by `key`. Empties are pinned to the bottom in BOTH directions —
 *  they are absent data, not the largest value, so flipping direction must not float them
 *  to the top. Only the comparison between two present values is reversed. */
export function sortItems<T extends ListItem>(items: T[], key: string | null, dir: SortDir): T[] {
  if (!key) return [...items];
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aEmpty = isEmpty(av);
    const bEmpty = isEmpty(bv);
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    return sign * compareValues(av, bv);
  });
}

/** The next sort state when a column header is clicked: a new column starts ascending,
 *  the active column toggles. */
export function nextSort(
  current: { key: string | null; dir: SortDir },
  key: string,
): { key: string; dir: SortDir } {
  if (current.key !== key) return { key, dir: 'asc' };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/* ── Defaults ───────────────────────────────────── */

/** Fields that become list columns — everything not marked form-only. */
export function columnFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter((f) => !f.formOnly);
}

/** Default search keys: every field, including form-only ones. Notes you cannot see in a
 *  column are still worth finding by. */
export function defaultSearchKeys(fields: FieldDef[]): string[] {
  return fields.map((f) => f.key);
}

/** Default sortable columns: the visible ones, minus textareas (free prose sorts as noise). */
export function defaultSortableKeys(fields: FieldDef[]): string[] {
  return columnFields(fields)
    .filter((f) => f.type !== 'textarea')
    .map((f) => f.key);
}
