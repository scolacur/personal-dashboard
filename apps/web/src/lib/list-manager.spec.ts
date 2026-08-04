import { describe, expect, it } from 'vitest';
import {
  cleanDraft,
  coerceValue,
  columnFields,
  compareValues,
  defaultSearchKeys,
  defaultSortableKeys,
  emptyDraft,
  filterItems,
  formatValue,
  matchesQuery,
  nextSort,
  sortItems,
  toDraft,
  validateDraft,
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
