import { describe, expect, it } from 'vitest';
import {
  cleanDraft,
  clearDisabledFields,
  coerceValue,
  columnFields,
  isFieldEnabled,
  countLabel,
  searchScopeLabel,
  visibleColumns,
  compareValues,
  defaultSearchKeys,
  defaultSortableKeys,
  emptyDraft,
  filterItems,
  formatValue,
  matchesQuery,
  nextSort,
  readField,
  sortItems,
  toDraft,
  validateDraft,
  type Draft,
  type FieldDef,
} from './list-manager';

// Fixtures modelled on the two real callers this component has to fit: the acute-strategies
// idea list and the Buy/Sell/Trade gear list (PD-437).
const IDEA_FIELDS: FieldDef[] = [
  { key: 'text', label: 'Text', type: 'textarea', required: true },
  { key: 'type', label: 'Type', type: 'select', options: ['Acute', 'Oblique'], required: true },
  { key: 'tags', label: 'Tags', type: 'text' },
];

const GEAR_FIELDS: FieldDef[] = [
  { key: 'type', label: 'Type', type: 'select', options: ['WTB', 'WTS', 'WTT'], required: true },
  { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
  { key: 'module', label: 'Module', type: 'text', required: true },
  { key: 'price', label: 'Price', type: 'number' },
  { key: 'notes', label: 'Notes', type: 'textarea', formOnly: true },
];

const gear = [
  { id: 1, type: 'WTS', manufacturer: 'Make Noise', module: 'Maths', price: 250, notes: 'mint' },
  { id: 2, type: 'WTS', manufacturer: 'Mutable', module: 'Plaits', price: 180, notes: '' },
  { id: 3, type: 'WTB', manufacturer: 'Intellijel', module: 'Quadrax', price: null, notes: null },
  { id: 4, type: 'WTT', manufacturer: 'ALM', module: 'Pamela', price: 0, notes: undefined },
];

// PD-437 regression: the component's first real caller could not compile, because
// `ListItem = Record<string, unknown>` rejects a TS *interface* (no implicit index signature)
// and every domain type in this app is an interface. This is a compile-time test — if the
// constraint tightens back to `Record`, `tsc` fails here rather than in a distant caller.
interface DomainRecord {
  id: number;
  module: string;
  price: string | null;
}

describe('ListItem constraint', () => {
  it('accepts a plain interface, not just an index-signature type', () => {
    const rows: DomainRecord[] = [
      { id: 1, module: 'Maths', price: '$250' },
      { id: 2, module: 'Plaits', price: null },
    ];
    // Each of these would fail to typecheck under a `Record<string, unknown>` constraint.
    expect(filterItems(rows, 'math', ['module']).map((r) => r.id)).toEqual([1]);
    expect(sortItems(rows, 'module', 'asc').map((r) => r.module)).toEqual(['Maths', 'Plaits']);
    expect(toDraft(rows[0], [{ key: 'module', label: 'Module', type: 'text' }])).toEqual({
      module: 'Maths',
    });
  });

  it('readField reads a key off an interface-typed record', () => {
    const row: DomainRecord = { id: 1, module: 'Maths', price: null };
    expect(readField(row, 'module')).toBe('Maths');
    expect(readField(row, 'price')).toBeNull();
    expect(readField(row, 'nope')).toBeUndefined();
  });
});

describe('formatValue', () => {
  it('renders arrays as comma-joined text so tag fields stay searchable', () => {
    expect(formatValue(['synth', 'ambient'])).toBe('synth, ambient');
  });

  it('renders null and undefined as empty string', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('preserves zero rather than blanking it', () => {
    expect(formatValue(0)).toBe('0');
  });
});

describe('matchesQuery / filterItems', () => {
  it('matches case-insensitively across the given keys', () => {
    expect(matchesQuery(gear[0], 'MAKE NOISE', ['manufacturer', 'module'])).toBe(true);
    expect(matchesQuery(gear[0], 'maths', ['module'])).toBe(true);
  });

  it('matches on a substring, not just a prefix', () => {
    expect(matchesQuery(gear[1], 'lait', ['module'])).toBe(true);
  });

  it('does not match keys it was not given', () => {
    expect(matchesQuery(gear[0], 'mint', ['module'])).toBe(false);
    expect(matchesQuery(gear[0], 'mint', ['module', 'notes'])).toBe(true);
  });

  it('treats a blank or whitespace-only query as "match everything"', () => {
    expect(filterItems(gear, '', ['module'])).toHaveLength(4);
    expect(filterItems(gear, '   ', ['module'])).toHaveLength(4);
  });

  it('returns a copy, never the original array', () => {
    const out = filterItems(gear, '', ['module']);
    expect(out).not.toBe(gear);
  });

  it('filters down to matching rows', () => {
    expect(filterItems(gear, 'wts', ['type']).map((g) => g.id)).toEqual([1, 2]);
  });

  it('tolerates null and undefined values in searched keys', () => {
    expect(() => filterItems(gear, 'x', ['notes', 'price'])).not.toThrow();
    expect(filterItems(gear, 'x', ['notes'])).toHaveLength(0);
  });
});

describe('compareValues', () => {
  it('compares numbers numerically, not lexically', () => {
    expect(compareValues(9, 100)).toBeLessThan(0);
  });

  it('compares strings case-insensitively', () => {
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
  });

  it('sorts empty values after present ones', () => {
    expect(compareValues(null, 'a')).toBeGreaterThan(0);
    expect(compareValues('a', null)).toBeLessThan(0);
    expect(compareValues(undefined, 'a')).toBeGreaterThan(0);
    expect(compareValues('', 'a')).toBeGreaterThan(0);
    expect(compareValues('   ', 'a')).toBeGreaterThan(0);
  });

  it('treats two empties as equal', () => {
    expect(compareValues(null, undefined)).toBe(0);
    expect(compareValues('', null)).toBe(0);
  });

  it('treats zero as a value, not as empty', () => {
    expect(compareValues(0, 5)).toBeLessThan(0);
    expect(compareValues(0, null)).toBeLessThan(0);
  });
});

describe('sortItems', () => {
  it('sorts ascending by a string column', () => {
    expect(sortItems(gear, 'module', 'asc').map((g) => g.module)).toEqual([
      'Maths',
      'Pamela',
      'Plaits',
      'Quadrax',
    ]);
  });

  it('sorts descending by a string column', () => {
    expect(sortItems(gear, 'module', 'desc').map((g) => g.module)).toEqual([
      'Quadrax',
      'Plaits',
      'Pamela',
      'Maths',
    ]);
  });

  it('sorts numbers numerically in both directions', () => {
    expect(sortItems(gear, 'price', 'asc').map((g) => g.price)).toEqual([0, 180, 250, null]);
    expect(sortItems(gear, 'price', 'desc').map((g) => g.price)).toEqual([250, 180, 0, null]);
  });

  it('keeps empty values last when the direction flips — absent data is not the largest value', () => {
    const asc = sortItems(gear, 'price', 'asc');
    const desc = sortItems(gear, 'price', 'desc');
    expect(asc[asc.length - 1].price).toBeNull();
    expect(desc[desc.length - 1].price).toBeNull();
  });

  it('returns a copy and leaves the input untouched', () => {
    const before = gear.map((g) => g.id);
    const out = sortItems(gear, 'module', 'desc');
    expect(out).not.toBe(gear);
    expect(gear.map((g) => g.id)).toEqual(before);
  });

  it('is a no-op copy when no sort column is set', () => {
    expect(sortItems(gear, null, 'asc').map((g) => g.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('nextSort', () => {
  it('starts a newly clicked column ascending', () => {
    expect(nextSort({ key: 'module', dir: 'desc' }, 'price')).toEqual({ key: 'price', dir: 'asc' });
    expect(nextSort({ key: null, dir: 'asc' }, 'price')).toEqual({ key: 'price', dir: 'asc' });
  });

  it('toggles direction on the active column', () => {
    expect(nextSort({ key: 'price', dir: 'asc' }, 'price')).toEqual({ key: 'price', dir: 'desc' });
    expect(nextSort({ key: 'price', dir: 'desc' }, 'price')).toEqual({ key: 'price', dir: 'asc' });
  });
});

describe('drafts', () => {
  it('emptyDraft has every field present and empty', () => {
    expect(emptyDraft(GEAR_FIELDS)).toEqual({
      type: null,
      manufacturer: null,
      module: null,
      price: null,
      notes: null,
    });
  });

  it('toDraft seeds from a record, keeping numbers as numbers', () => {
    const d = toDraft(gear[0], GEAR_FIELDS);
    expect(d.module).toBe('Maths');
    expect(d.price).toBe(250);
  });

  it('toDraft normalises missing, blank and undefined values to null', () => {
    const d = toDraft(gear[2], GEAR_FIELDS);
    expect(d.price).toBeNull();
    expect(d.notes).toBeNull();
    expect(toDraft(gear[1], GEAR_FIELDS).notes).toBeNull();
  });

  it('toDraft keeps a zero rather than nulling it', () => {
    expect(toDraft(gear[3], GEAR_FIELDS).price).toBe(0);
  });

  it('toDraft flattens array values for a text field', () => {
    const d = toDraft({ text: 'x', type: 'Acute', tags: ['a', 'b'] }, IDEA_FIELDS);
    expect(d.tags).toBe('a, b');
  });
});

describe('coerceValue', () => {
  const price = GEAR_FIELDS.find((f) => f.key === 'price')!;
  const module = GEAR_FIELDS.find((f) => f.key === 'module')!;

  it('turns a numeric string into a number', () => {
    expect(coerceValue(price, '250')).toBe(250);
    expect(coerceValue(price, '0')).toBe(0);
  });

  it('turns an unparseable number into null rather than NaN', () => {
    expect(coerceValue(price, 'abc')).toBeNull();
  });

  it('turns a cleared control into null', () => {
    expect(coerceValue(price, '')).toBeNull();
    expect(coerceValue(module, '')).toBeNull();
  });

  it('leaves text as text', () => {
    expect(coerceValue(module, 'Maths')).toBe('Maths');
  });
});

describe('validateDraft', () => {
  it('passes a complete draft', () => {
    expect(validateDraft(GEAR_FIELDS, { type: 'WTS', module: 'Maths', price: 100 })).toEqual({});
  });

  it('flags a missing required field', () => {
    const errors = validateDraft(GEAR_FIELDS, { type: 'WTS', module: null });
    expect(errors.module).toMatch(/required/i);
    expect(errors.type).toBeUndefined();
  });

  it('flags a whitespace-only required field', () => {
    expect(validateDraft(GEAR_FIELDS, { type: 'WTS', module: '   ' }).module).toMatch(/required/i);
  });

  it('does not flag an empty optional field', () => {
    expect(validateDraft(GEAR_FIELDS, { type: 'WTS', module: 'Maths', price: null })).toEqual({});
  });

  it('accepts zero for a required numeric field', () => {
    const fields: FieldDef[] = [{ key: 'n', label: 'N', type: 'number', required: true }];
    expect(validateDraft(fields, { n: 0 })).toEqual({});
  });

  it('flags a non-numeric value on a number field', () => {
    expect(validateDraft(GEAR_FIELDS, { type: 'WTS', module: 'Maths', price: 'abc' }).price).toMatch(
      /number/i,
    );
  });
});

describe('cleanDraft', () => {
  it('drops empty values and trims strings', () => {
    expect(cleanDraft({ module: '  Maths  ', manufacturer: '', price: null })).toEqual({
      module: 'Maths',
    });
  });

  it('keeps zero', () => {
    expect(cleanDraft({ price: 0 })).toEqual({ price: 0 });
  });
});

describe('field defaults', () => {
  it('columnFields drops form-only fields', () => {
    expect(columnFields(GEAR_FIELDS).map((f) => f.key)).toEqual([
      'type',
      'manufacturer',
      'module',
      'price',
    ]);
  });

  it('defaultSearchKeys includes form-only fields — hidden notes are still worth finding by', () => {
    expect(defaultSearchKeys(GEAR_FIELDS)).toContain('notes');
  });

  it('defaultSortableKeys excludes textareas and form-only fields', () => {
    expect(defaultSortableKeys(GEAR_FIELDS)).toEqual(['type', 'manufacturer', 'module', 'price']);
    expect(defaultSortableKeys(IDEA_FIELDS)).toEqual(['type', 'tags']);
  });
});

// PD-475 primitives.
describe('visibleColumns', () => {
  it('is columnFields when nothing is hidden', () => {
    expect(visibleColumns(GEAR_FIELDS).map((f) => f.key)).toEqual(
      columnFields(GEAR_FIELDS).map((f) => f.key),
    );
  });

  // The BST page splits its list into four tables by sale status, so a sale-status column would
  // repeat the table's own heading on every row.
  it('drops hidden keys while leaving them searchable and editable', () => {
    expect(visibleColumns(GEAR_FIELDS, ['type', 'price']).map((f) => f.key)).toEqual([
      'manufacturer',
      'module',
    ]);
    // Hiding a column must not remove the field — the modal and the filter still see it.
    expect(defaultSearchKeys(GEAR_FIELDS)).toContain('type');
  });

  it('ignores a hidden key that is already form-only or unknown', () => {
    expect(visibleColumns(GEAR_FIELDS, ['notes', 'nope']).map((f) => f.key)).toEqual(
      columnFields(GEAR_FIELDS).map((f) => f.key),
    );
  });
});

describe('countLabel', () => {
  it('pluralises on the total, not on the shown subset', () => {
    expect(countLabel(1, 1, 'listing')).toBe('1 listing');
    expect(countLabel(12, 12, 'listing')).toBe('12 listings');
    // "1 of 12 listing" would be wrong — the noun agrees with what is being counted from.
    expect(countLabel(1, 12, 'listing')).toBe('1 of 12 listings');
  });

  it('reads as a bare count when the heading already says what it holds', () => {
    expect(countLabel(12, 12, 'listing', 'parens')).toBe('(12)');
    expect(countLabel(3, 12, 'listing', 'parens')).toBe('(3 of 12)');
  });

  it('handles an empty list', () => {
    expect(countLabel(0, 0, 'listing')).toBe('0 listings');
    expect(countLabel(0, 0, 'listing', 'parens')).toBe('(0)');
  });
});

describe('searchScopeLabel', () => {
  it('names the fields the filter box searches, using their labels', () => {
    expect(searchScopeLabel(GEAR_FIELDS, ['manufacturer', 'module'])).toBe(
      'Searches Manufacturer, Module',
    );
  });

  it('falls back to the raw key for a search key with no matching field', () => {
    expect(searchScopeLabel(GEAR_FIELDS, ['mystery'])).toBe('Searches mystery');
  });
});

describe('conditional fields (enabledWhen)', () => {
  const sellingOnly = (d: Draft): boolean => d.type !== 'WTB';
  const FIELDS: FieldDef[] = [
    { key: 'type', label: 'Type', type: 'segmented', options: ['WTB', 'WTS'], required: true },
    { key: 'item', label: 'Item', type: 'text', required: true },
    { key: 'price', label: 'Price', type: 'text', enabledWhen: sellingOnly },
    { key: 'condition', label: 'Condition', type: 'text', enabledWhen: sellingOnly },
    { key: 'aliases', label: 'Also known as', type: 'text' },
  ];

  it('leaves a field with no rule always enabled', () => {
    expect(isFieldEnabled(FIELDS[1], { type: 'WTB' })).toBe(true);
    expect(isFieldEnabled(FIELDS[4], { type: 'WTB' })).toBe(true);
  });

  it('switches the sale-side fields off for a want', () => {
    expect(isFieldEnabled(FIELDS[2], { type: 'WTB' })).toBe(false);
    expect(isFieldEnabled(FIELDS[2], { type: 'WTS' })).toBe(true);
  });

  it('clears the values of disabled fields, and only those', () => {
    // Switching WTS → WTB after typing a price must not leave the price on a row where nothing
    // displays it — invisible data that reappears if the row is switched back.
    const draft: Draft = {
      type: 'WTB',
      item: 'Maths',
      price: '$250',
      condition: 'Mint',
      aliases: 'maffs',
    };
    expect(clearDisabledFields(FIELDS, draft)).toEqual({
      type: 'WTB',
      item: 'Maths',
      price: null,
      condition: null,
      aliases: 'maffs',
    });
  });

  it('leaves an all-enabled draft untouched', () => {
    const draft: Draft = { type: 'WTS', item: 'Maths', price: '$250', condition: null, aliases: null };
    expect(clearDisabledFields(FIELDS, draft)).toEqual(draft);
  });

  it('does not hold a disabled field to its required rule', () => {
    // Otherwise the form could become unsubmittable with no control to fix it through.
    const fields: FieldDef[] = [
      { key: 'type', label: 'Type', type: 'segmented', options: ['WTB', 'WTS'] },
      { key: 'price', label: 'Price', type: 'text', required: true, enabledWhen: sellingOnly },
    ];
    expect(validateDraft(fields, { type: 'WTB', price: null })).toEqual({});
    expect(validateDraft(fields, { type: 'WTS', price: null })).toHaveProperty('price');
  });
});
