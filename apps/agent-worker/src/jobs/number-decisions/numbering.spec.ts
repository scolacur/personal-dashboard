import { describe, expect, it } from 'vitest';
import type { Decision, ProvisionalDecision } from '../../shared/decisions';
import {
  assignNumbers,
  danglingIds,
  MAX_SLUG_LENGTH,
  renumberHeading,
  rewriteCitations,
  slugify,
} from './numbering';

function numbered(num: number): Decision {
  const id = `D-${String(num).padStart(3, '0')}`;
  return { id, num, slug: 'x', title: 't', file: `DECISIONS/${id}-x.md` };
}

function prov(ticketNum: number, title: string, letter = 'a'): ProvisionalDecision {
  const id = `D-TMP-PD${ticketNum}${letter}`;
  return { id, ticketPrefix: 'PD', ticketNum, letter, title, file: `DECISIONS/incoming/${id}.md` };
}

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('The Epic is the unit of dispatch')).toBe('the-epic-is-the-unit-of-dispatch');
  });

  it('drops punctuation rather than turning it into hyphens mid-word', () => {
    expect(slugify("A worker reports the commit it was BUILT from")).toBe('a-worker-reports-the-commit-it-was-built-from');
    expect(slugify('the loop’s own ledger')).toBe('the-loops-own-ledger');
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(slugify('  Decisions — authored, provisionally  ')).toBe('decisions-authored-provisionally');
  });

  it('truncates at a word boundary, never mid-word', () => {
    const title = 'The Epic becomes the unit of priority and dispatch and the prioritized lane is removed entirely';
    const slug = slugify(title);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    // Whatever the cut lands on, it is a whole word from the title.
    for (const word of slug.split('-')) expect(title.toLowerCase()).toContain(word);
  });

  it('always produces something a decision filename parser will accept', () => {
    for (const title of ['— — —', '2026', 'a', '...!!!']) {
      expect(slugify(title)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe('assignNumbers', () => {
  it('starts one past the highest number already claimed', () => {
    const out = assignNumbers([numbered(79), numbered(12)], [prov(383, 'First')]);
    expect(out[0].id).toBe('D-080');
    expect(out[0].file).toBe('DECISIONS/D-080-first.md');
  });

  it('numbers in the order given, which the caller sets to merge order', () => {
    const out = assignNumbers([numbered(79)], [prov(600, 'Merged first'), prov(383, 'Merged second')]);
    expect(out.map((a) => a.id)).toEqual(['D-080', 'D-081']);
    // Explicitly NOT sorted by ticket number — PD-600 merged first, so it gets the lower id.
    expect(out[0].from.ticketNum).toBe(600);
  });

  it('allocates from the highest and never back-fills a gap', () => {
    // A gap at D-050 is left alone: filling it would put a decision made today before one made
    // months ago in the log's own ordering.
    const out = assignNumbers([numbered(79), numbered(49)], [prov(1, 'x')]);
    expect(out[0].num).toBe(80);
  });

  it('starts at D-001 against an empty log', () => {
    expect(assignNumbers([], [prov(1, 'x')])[0].id).toBe('D-001');
  });

  it('gives every assignment a distinct id and path', () => {
    const out = assignNumbers([numbered(79)], [prov(1, 'Same title'), prov(2, 'Same title')]);
    expect(new Set(out.map((a) => a.id)).size).toBe(2);
    expect(new Set(out.map((a) => a.file)).size).toBe(2);
  });
});

describe('rewriteCitations', () => {
  const assignments = assignNumbers([numbered(79)], [prov(383, 'Epic dispatch'), prov(513, 'Memory inbox')]);

  it('rewrites a citation wherever it appears', () => {
    const before = 'See D-TMP-PD383a for the model, and D-TMP-PD513a for memory.';
    expect(rewriteCitations(before, assignments)).toBe('See D-080 for the model, and D-081 for memory.');
  });

  it('rewrites inside prose, code comments, and links alike', () => {
    expect(rewriteCitations('[D-TMP-PD383a](DECISIONS/incoming/D-TMP-PD383a.md)', assignments)).toBe(
      '[D-080](DECISIONS/incoming/D-080.md)',
    );
  });

  it('never touches a numbered citation', () => {
    const before = 'D-070 and D-078 stay exactly as they are.';
    expect(rewriteCitations(before, assignments)).toBe(before);
  });

  it('does not let one id match inside a longer one', () => {
    // `D-TMP-PD38a` is a prefix of `D-TMP-PD383a` in plain string terms. Without a boundary the
    // shorter id's rewrite would corrupt the longer one.
    const two = assignNumbers([numbered(79)], [prov(38, 'Short'), prov(383, 'Long')]);
    expect(rewriteCitations('D-TMP-PD383a', two)).toBe('D-081');
    expect(rewriteCitations('D-TMP-PD38a', two)).toBe('D-080');
  });

  it('leaves an unassigned provisional id alone rather than guessing', () => {
    const before = 'D-TMP-PD999z was never in the inbox.';
    expect(rewriteCitations(before, assignments)).toBe(before);
  });

  it('is a no-op on text with no citations', () => {
    expect(rewriteCitations('nothing to see', assignments)).toBe('nothing to see');
  });
});

describe('danglingIds', () => {
  const assignments = assignNumbers([numbered(79)], [prov(383, 'Epic dispatch')]);

  it('reports a citation with no decision behind it', () => {
    expect(danglingIds('cites D-TMP-PD383a and D-TMP-PD999z', assignments)).toEqual(['D-TMP-PD999z']);
  });

  it('deduplicates and sorts', () => {
    expect(danglingIds('D-TMP-PDb2a D-TMP-PDa1a D-TMP-PDb2a', assignments)).toEqual(['D-TMP-PDa1a', 'D-TMP-PDb2a']);
  });

  it('is empty when every citation is covered', () => {
    expect(danglingIds('only D-TMP-PD383a here', assignments)).toEqual([]);
  });
});

describe('renumberHeading', () => {
  const [assignment] = assignNumbers([numbered(79)], [prov(383, 'The Epic is the unit of dispatch')]);

  it('replaces the id and carries the title across verbatim', () => {
    const before = '# D-TMP-PD383a: The Epic is the unit of dispatch\n\n**Decision:** ...\n';
    expect(renumberHeading(before, assignment)).toBe('# D-080: The Epic is the unit of dispatch\n\n**Decision:** ...\n');
  });

  it('leaves the body untouched, including later D-TMP- citations', () => {
    // The body is rewritten by rewriteCitations, not here — this function owns line 1 only.
    const before = '# D-TMP-PD383a: T\n\nsee D-TMP-PD383a below\n';
    expect(renumberHeading(before, assignment)).toContain('see D-TMP-PD383a below');
  });

  it('produces a heading whose id agrees with the assigned filename', () => {
    // loadDecisions throws when these disagree, so this pairing is the actual contract.
    const out = renumberHeading('# D-TMP-PD383a: T\n', assignment);
    expect(out.split('\n')[0]).toBe(`# ${assignment.id}: The Epic is the unit of dispatch`);
    expect(assignment.file).toContain(assignment.id);
  });
});
