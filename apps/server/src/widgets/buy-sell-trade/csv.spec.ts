import { describe, expect, it } from 'vitest';
import { mapHeaders, parseCsv, parseListingsCsv } from './csv';

// The real export's header row, verbatim from the sheet — note the leading title column,
// which is not a field and must be ignored rather than breaking the mapping.
const REAL_HEADER =
  "Holographic b_boys's Module FS List,Type,Manufacturer,Module,Price,Condition,Notes,Current Location (For my personal reference)";

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('keeps newlines inside quoted fields — a Notes cell can be multi-line', () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a final row with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toHaveLength(2);
  });

  it('drops wholly blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty fields rather than collapsing them', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('mapHeaders', () => {
  it('maps the real sheet header, ignoring the title column', () => {
    expect(mapHeaders(REAL_HEADER.split(','))).toEqual([
      null, // the list title — not a field
      'type',
      'manufacturer',
      'module',
      'price',
      'condition',
      'notes',
      'location', // "Current Location (For my personal reference)"
    ]);
  });

  // The real sheet's header carries an explanatory parenthetical. Matching it exactly would
  // drop the column silently and import every location as empty.
  it('drops a trailing parenthetical when matching a header', () => {
    expect(mapHeaders(['Current Location (For my personal reference)'])).toEqual(['location']);
    expect(mapHeaders(['Price (USD)'])).toEqual(['price']);
    expect(mapHeaders(['Current Location'])).toEqual(['location']);
  });

  it('does not treat a parenthetical mid-header as trailing', () => {
    expect(mapHeaders(['Module (v2) revision'])).toEqual([null]);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(mapHeaders([' MODULE ', 'manufacturer', 'Current   Location'])).toEqual([
      'module',
      'manufacturer',
      'location',
    ]);
  });
});

describe('parseListingsCsv', () => {
  const header = 'Type,Manufacturer,Module,Price,Condition,Notes,Current Location';

  it('parses well-formed rows', () => {
    const { rows, problems } = parseListingsCsv(
      `${header}\nWTS,Make Noise,Maths,$250 shipped,Mint,boxed,Rack A`,
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        type: 'WTS',
        manufacturer: 'Make Noise',
        module: 'Maths',
        price: '$250 shipped',
        condition: 'Mint',
        notes: 'boxed',
        location: 'Rack A',
      },
    ]);
  });

  it('preserves non-numeric prices verbatim', () => {
    const { rows } = parseListingsCsv(`${header}\nWTT,ALM,Pamela,trade only,,,`);
    expect(rows[0].price).toBe('trade only');
  });

  it('accepts loose casing and padding in Type', () => {
    const { rows } = parseListingsCsv(`${header}\n wts ,Mutable,Plaits,,,,`);
    expect(rows[0].type).toBe('WTS');
  });

  it('turns empty cells into null, not empty strings', () => {
    const { rows } = parseListingsCsv(`${header}\nWTB,,Quadrax,,,,`);
    expect(rows[0]).toMatchObject({ manufacturer: null, price: null, condition: null, notes: null });
  });

  it('skips a row with no Module and says which row', () => {
    const { rows, problems } = parseListingsCsv(`${header}\nWTS,Make Noise,,,,,`);
    expect(rows).toEqual([]);
    expect(problems[0]).toMatch(/row 2.*no Module/i);
  });

  it('skips a row with an unrecognised Type rather than guessing', () => {
    const { rows, problems } = parseListingsCsv(`${header}\nSOLD,Make Noise,Maths,,,,`);
    expect(rows).toEqual([]);
    expect(problems[0]).toMatch(/row 2 \(Maths\).*expected WTB, WTS or WTT/i);
  });

  it('keeps good rows when a bad one is present — one bad row does not lose the import', () => {
    const { rows, problems } = parseListingsCsv(
      `${header}\nWTS,Make Noise,Maths,,,,\nJUNK,X,Y,,,,\nWTB,Intellijel,Quadrax,,,,`,
    );
    expect(rows.map((r) => r.module)).toEqual(['Maths', 'Quadrax']);
    expect(problems).toHaveLength(1);
  });

  it('ignores blank rows in the middle of an export', () => {
    const { rows, problems } = parseListingsCsv(
      `${header}\nWTS,Make Noise,Maths,,,,\n,,,,,,\nWTB,Intellijel,Quadrax,,,,`,
    );
    expect(rows).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  it('refuses a CSV with no Module column instead of importing nothing silently', () => {
    const { rows, problems } = parseListingsCsv('Foo,Bar\n1,2');
    expect(rows).toEqual([]);
    expect(problems[0]).toMatch(/no "Module" column/i);
  });

  it('reports an empty CSV', () => {
    expect(parseListingsCsv('').problems).toEqual(['empty CSV']);
  });

  it('handles the real sheet header shape end to end, including Current Location', () => {
    const { rows, problems } = parseListingsCsv(
      `${REAL_HEADER}\n,WTS,Make Noise,Maths,$250,Mint,boxed,Rack A`,
    );
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({
      type: 'WTS',
      manufacturer: 'Make Noise',
      module: 'Maths',
      price: '$250',
      condition: 'Mint',
      notes: 'boxed',
      location: 'Rack A',
    });
  });
});
