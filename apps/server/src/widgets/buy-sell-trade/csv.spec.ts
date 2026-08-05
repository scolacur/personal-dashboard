import { describe, expect, it } from 'vitest';
import { mapHeaders, parseCsv, parseSheetCsv, repairMojibake } from './csv';

// Fixture modelled directly on the real sheet, because the first version of this importer
// assumed a flat table and rejected all 46 rows of it. The shape that matters:
//   - column 1 is prose: sale terms, then a "WTTF:" marker, then a want-list
//   - column 2 ("Type") is a SECTION marker that applies downward, not WTB/WTS/WTT
//   - one row can carry a terms line, a section change and a listing at once
const HEADER =
  "Holographic b_boys's Module FS List,Type,Manufacturer,Module,Price,Condition,Notes,Current Location (For my personal reference)";

const SHEET = [
  HEADER,
  ',,,,,,,',
  '"Everything, unless otherwise specified, is:",MODULES,,,,,,',
  'like new condition,,,,,,,',
  'purchased new by me,,SSF,Ultra Perc,$380,Excellent,"purchased new, has og box",',
  'Will consider offers.,,Boredbrain,OPTX,$275,excellent,,Box 2',
  'WTTF (partial trades in case of value mismatch):,,2hp,Slice,$115,Good,,',
  'acidlab m303,,,,,,,',
  'Xodes UGR2,MISC,AmpTone Lab,Powered MIDI 1-4 Splitter,$35,,,',
  'Sloths 1U,Feelers,ALM,mmMidi,$100,Excellent,,Video Rack',
  'Non-modular,,Befaco,Motion MTR,,brand new,og box,Box 1',
  'Future Retro Orb,,Klavis,Quadigy,,excellent,og box,Box 2',
  ",Probably won't sell,Alright Devices,Chronoblob,$250,Excellent,purchased used,Racked",
  ',,knob.farm,hrylo (gold),,excellent,og box,',
].join('\n');

describe('parseCsv', () => {
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

  it('preserves empty fields rather than collapsing them', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('mapHeaders', () => {
  it('maps the real sheet header — prose column unmapped, location despite its parenthetical', () => {
    expect(mapHeaders(HEADER.split(','))).toEqual([
      null, // the prose column, titled with the list's name
      'type',
      'manufacturer',
      'item',
      'price',
      'condition',
      'notes',
      'location',
    ]);
  });

  it('drops a trailing parenthetical when matching a header', () => {
    expect(mapHeaders(['Current Location (For my personal reference)'])).toEqual(['location']);
    expect(mapHeaders(['Price (USD)'])).toEqual(['price']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(mapHeaders([' MODULE ', 'Current   Location'])).toEqual(['item', 'location']);
  });

  // The sheet says "Module", the model says `item` — the list is gear, not modules. Both
  // headers map to the same field so an old export and a future one both import.
  it('accepts Module, Item and Gear as the same column', () => {
    expect(mapHeaders(['Module'])).toEqual(['item']);
    expect(mapHeaders(['Item'])).toEqual(['item']);
    expect(mapHeaders(['Gear'])).toEqual(['item']);
  });

  it('maps the public/private notes split', () => {
    expect(mapHeaders(['Notes', 'Private Notes'])).toEqual(['notes', 'privateNotes']);
    expect(mapHeaders(['Public Notes'])).toEqual(['notes']);
  });
});

describe('parseSheetCsv — the real sheet shape', () => {
  const out = parseSheetCsv(SHEET);
  const byItem = (m: string) => out.rows.find((r) => r.item === m);

  it('imports module rows as WTS by default — the sheet is a For Sale list', () => {
    expect(byItem('Ultra Perc')).toMatchObject({ type: 'WTS', manufacturer: 'SSF', price: '$380' });
  });

  it('does not treat a section marker as a listing type', () => {
    expect(byItem('mmMidi')?.type).toBe('WTS');
    expect(byItem('Chronoblob')?.type).toBe('WTS');
  });

  it('splits a section marker into sale status + category, applied downward', () => {
    expect(byItem('Ultra Perc')).toMatchObject({ saleStatus: 'for-sale', category: 'Modules' });
    expect(byItem('OPTX')).toMatchObject({ saleStatus: 'for-sale', category: 'Modules' });
    expect(byItem('Powered MIDI 1-4 Splitter')).toMatchObject({
      saleStatus: 'for-sale',
      category: 'Misc',
    });
    expect(byItem('mmMidi')?.saleStatus).toBe('feelers');
    // still feelers — the marker persists past the row it appears on
    expect(byItem('Motion MTR')?.saleStatus).toBe('feelers');
    expect(byItem('Quadigy')?.saleStatus).toBe('feelers');
    expect(byItem('Chronoblob')?.saleStatus).toBe('probably-wont-sell');
    expect(byItem('hrylo (gold)')?.saleStatus).toBe('probably-wont-sell');
  });

  it('resets category to Modules when a willingness marker starts', () => {
    // MISC is in force immediately before Feelers; carrying it forward would mislabel
    // every feeler as Misc.
    expect(byItem('Powered MIDI 1-4 Splitter')?.category).toBe('Misc');
    expect(byItem('mmMidi')?.category).toBe('Modules');
  });

  it('extracts the sale terms from column 1, above the WTTF marker', () => {
    expect(out.terms).toBe(
      ['Everything, unless otherwise specified, is:', 'like new condition', 'purchased new by me', 'Will consider offers.'].join('\n'),
    );
  });

  it('stops collecting terms at the WTTF marker, and excludes the marker itself', () => {
    expect(out.terms).not.toMatch(/WTTF/);
    expect(out.terms).not.toMatch(/acidlab/);
  });

  // WTTF is a heading about HOW he'd pay; the rows under it are wants, so they import as WTB.
  // WTT was retired as a listing type — see BST_LISTING_TYPES.
  it('imports the want-list below the WTTF marker as WTB rows', () => {
    const wants = out.rows.filter((r) => r.type === 'WTB');
    expect(wants.map((w) => w.item)).toEqual([
      'acidlab m303',
      'Xodes UGR2',
      'Sloths 1U',
      'Future Retro Orb',
    ]);
    // A want is not something Steve is offering, so neither field applies.
    expect(wants.every((w) => w.saleStatus === null && w.category === null)).toBe(true);
  });

  it('skips "Non-modular" — a sub-heading in the want list, not a wanted item', () => {
    expect(out.rows.some((r) => r.item === 'Non-modular')).toBe(false);
  });

  it('reads a terms line, a section change and a listing off the SAME row independently', () => {
    // 'Sloths 1U,Feelers,ALM,mmMidi,...' is a want, a section marker and a listing at once.
    expect(out.rows.some((r) => r.type === 'WTB' && r.item === 'Sloths 1U')).toBe(true);
    expect(byItem('mmMidi')).toMatchObject({ saleStatus: 'feelers', manufacturer: 'ALM' });
  });

  it('ignores spacer rows without reporting them as problems', () => {
    expect(out.problems).toEqual([]);
  });

  it('keeps a non-numeric price verbatim', () => {
    const priced = parseSheetCsv(`${HEADER}\n,,Doepfer,A-111-5,TBD,Excellent,,Box`);
    expect(priced.rows[0].price).toBe('TBD');
  });

  it('turns empty cells into null, not empty strings', () => {
    expect(byItem('hrylo (gold)')).toMatchObject({ price: null, location: null });
  });
});

// The real export mis-encodes its Cyrillic module names (UTF-8 bytes decoded as Latin-1).
// This is not cosmetic: PD-438 matches r/modular comments on the module NAME, so a mangled
// name can never match.
describe('repairMojibake', () => {
  const cases: [string, string][] = [
    ['СЛИМИКС 6 Channel 1U Mixer with mutes and panning', 'Пуск-3'],
  ].flat().map((want) => [Buffer.from(want, 'utf8').toString('latin1'), want] as [string, string]);

  for (const [broken, want] of cases) {
    it(`repairs "${want.slice(0, 20)}…"`, () => {
      expect(repairMojibake(broken)).toBe(want);
    });
  }

  it('leaves clean ASCII untouched', () => {
    for (const s of ["Pamela's PRO Workout", 'Pico Case (3U, 42hp)', 'A-145-4 Quad LFO', '2hp Mix']) {
      expect(repairMojibake(s)).toBe(s);
    }
  });

  it('leaves already-correct non-ASCII untouched', () => {
    for (const s of ['Пуск-3', 'café', 'naïve', 'Erica Synths – Pico']) {
      expect(repairMojibake(s)).toBe(s);
    }
  });

  it('is idempotent — repairing twice does not damage the result', () => {
    const broken = Buffer.from('Пуск-3', 'utf8').toString('latin1');
    expect(repairMojibake(repairMojibake(broken))).toBe('Пуск-3');
  });

  it('repairs module names during a real import', () => {
    const broken = Buffer.from('Пуск-3', 'utf8').toString('latin1');
    const { rows } = parseSheetCsv(
      `Type,Manufacturer,Module,Price,Condition,Notes,Current Location\nWTS,Paratek,${broken},$80,excellent,,Box 2`,
    );
    expect(rows[0].item).toBe('Пуск-3');
  });
});

describe('parseSheetCsv — explicit types and failure modes', () => {
  const flat = 'Type,Manufacturer,Module,Price,Condition,Notes,Current Location';

  it('still honours an explicit WTB/WTS/WTT in the Type column', () => {
    const { rows } = parseSheetCsv(`${flat}\nWTB,Intellijel,Quadrax,,,,`);
    expect(rows[0]).toMatchObject({ type: 'WTB', item: 'Quadrax' });
  });

  it('accepts loose casing on an explicit type', () => {
    expect(parseSheetCsv(`${flat}\n wts ,Mutable,Plaits,,,,`).rows[0].type).toBe('WTS');
  });

  it('refuses a CSV with no Module column instead of importing nothing silently', () => {
    const { rows, problems } = parseSheetCsv('Foo,Bar\n1,2');
    expect(rows).toEqual([]);
    expect(problems[0]).toMatch(/no "Module" column/i);
  });

  it('reports a CSV whose Module column is entirely empty', () => {
    const { rows, problems } = parseSheetCsv(`${flat}\nWTS,SSF,,,,,`);
    expect(rows).toEqual([]);
    expect(problems[0]).toMatch(/no rows with a Module/i);
  });

  it('reports an empty CSV', () => {
    expect(parseSheetCsv('').problems).toEqual(['empty CSV']);
  });

  it('returns null terms when the sheet has no prose column', () => {
    expect(parseSheetCsv(`${flat}\nWTS,SSF,Ultra Perc,,,,`).terms).toBeNull();
  });
});
