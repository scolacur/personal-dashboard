import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISIONS_INDEX,
  findRepoRoot,
  loadDecisions,
  loadProvisionalDecisions,
  nextDecisionId,
  parseDecisionFilename,
  parseDecisionHeading,
  parseProvisionalFilename,
  parseProvisionalHeading,
  renderDecisionsIndex,
  type Decision,
  type ProvisionalDecision,
} from './decisions';

const REPO_ROOT = findRepoRoot(__dirname);

function decision(num: number, title: string, slug = 'x'): Decision {
  const id = `D-${String(num).padStart(3, '0')}`;
  return { id, num, slug, title, file: `DECISIONS/${id}-${slug}.md` };
}

function provisional(ticketNum: number, title: string, letter = 'a'): ProvisionalDecision {
  const id = `D-TMP-PD${ticketNum}${letter}`;
  return { id, ticketPrefix: 'PD', ticketNum, letter, title, file: `DECISIONS/incoming/${id}.md` };
}

describe('parseDecisionFilename', () => {
  it('reads the number and slug out of a well-formed name', () => {
    expect(parseDecisionFilename('D-046-sortie-after-run-safety-net.md')).toEqual({
      num: 46,
      slug: 'sortie-after-run-safety-net',
    });
  });

  it('requires the number to be zero-padded to three digits', () => {
    // D-46 and D-046 would be two names for one decision, and only one of them matches the ~1,000
    // citations in the repo. There is one spelling.
    expect(parseDecisionFilename('D-46-something.md')).toBeNull();
    expect(parseDecisionFilename('D-0046-something.md')).toBeNull();
  });

  it('rejects anything that is not D-NNN-slug.md', () => {
    expect(parseDecisionFilename('README.md')).toBeNull();
    expect(parseDecisionFilename('D-046.md')).toBeNull();
    expect(parseDecisionFilename('D-046-Mixed-Case.md')).toBeNull();
  });
});

describe('parseDecisionHeading', () => {
  it('reads the title off the first line', () => {
    expect(parseDecisionHeading('# D-070: One decision per file\n\n**Decision:** ...')).toEqual({
      num: 70,
      title: 'One decision per file',
    });
  });

  it('returns null when the first line is not a decision heading', () => {
    expect(parseDecisionHeading('## D-070: Wrong level\n')).toBeNull();
    expect(parseDecisionHeading('# D-070:\n')).toBeNull();
    expect(parseDecisionHeading('\n# D-070: Not first\n')).toBeNull();
  });
});

describe('parseProvisionalFilename', () => {
  it('reads the ticket and letter out of a well-formed name', () => {
    expect(parseProvisionalFilename('D-TMP-PD383a.md')).toEqual({
      id: 'D-TMP-PD383a',
      ticketPrefix: 'PD',
      ticketNum: 383,
      letter: 'a',
    });
  });

  it('rejects anything that is not D-TMP-<TICKET><letter>.md', () => {
    expect(parseProvisionalFilename('D-TMP-PD383.md')).toBeNull(); // no letter
    expect(parseProvisionalFilename('D-TMP-pd383a.md')).toBeNull(); // lowercase prefix
    expect(parseProvisionalFilename('D-TMP-PD383a-with-slug.md')).toBeNull();
    expect(parseProvisionalFilename('D-079-numbered.md')).toBeNull();
    expect(parseProvisionalFilename('.gitkeep')).toBeNull();
  });

  it('can never be mistaken for a numbered decision, in either direction', () => {
    // This is what makes `grep -rl 'D-TMP-'` a safe blind rewrite (D-078): the two namespaces
    // cannot overlap, so the cycle cannot rewrite a real citation by accident.
    expect(parseDecisionFilename('D-TMP-PD383a.md')).toBeNull();
    expect(parseProvisionalFilename('D-046-sortie-after-run-safety-net.md')).toBeNull();
  });
});

describe('parseProvisionalHeading', () => {
  it('reads the title off the first line', () => {
    expect(parseProvisionalHeading('# D-TMP-PD383a: The Epic is the unit of dispatch\n\n**Decision:**')).toEqual({
      id: 'D-TMP-PD383a',
      ticketPrefix: 'PD',
      ticketNum: 383,
      letter: 'a',
      title: 'The Epic is the unit of dispatch',
    });
  });

  it('returns null when the first line is not a well-formed provisional heading', () => {
    expect(parseProvisionalHeading('## D-TMP-PD383a: Wrong level\n')).toBeNull();
    expect(parseProvisionalHeading('# D-TMP-PD383a:\n')).toBeNull();
    expect(parseProvisionalHeading('# D-TMP-pd383a: Bad id\n')).toBeNull();
    expect(parseProvisionalHeading('# D-079: Numbered\n')).toBeNull();
  });
});

describe('nextDecisionId', () => {
  it('is one past the highest claimed number, zero-padded', () => {
    expect(nextDecisionId([decision(70, 'a'), decision(12, 'b')])).toBe('D-071');
  });

  it('starts at D-001 on an empty log', () => {
    expect(nextDecisionId([])).toBe('D-001');
  });
});

describe('renderDecisionsIndex', () => {
  it('lists newest first, with a link to each file', () => {
    const out = renderDecisionsIndex([decision(70, 'Newer'), decision(12, 'Older')], []);
    expect(out).toContain('- **[D-070](DECISIONS/D-070-x.md)** — Newer');
    expect(out.indexOf('D-070')).toBeLessThan(out.indexOf('D-012'));
  });

  it('says it is generated, so nobody hand-edits a file that gets overwritten', () => {
    expect(renderDecisionsIndex([decision(1, 'a')], [])).toContain('generated');
  });

  it('tells an author to write the inbox, never a D-NNN file by hand', () => {
    const out = renderDecisionsIndex([decision(1, 'a')], []);
    expect(out).toContain('DECISIONS/incoming/D-TMP-<TICKET><letter>.md');
    expect(out).toContain('never a');
  });

  it('lists provisional decisions ABOVE the numbered ones', () => {
    // The whole point of indexing them (D-078): this file is injected into every agent's
    // orientation (D-071), so a merged-but-unnumbered decision that is missing here is one an
    // agent will happily re-litigate for up to a numbering cycle.
    const out = renderDecisionsIndex([decision(70, 'Numbered')], [provisional(513, 'Provisional')]);
    expect(out).toContain('- **[D-TMP-PD513a](DECISIONS/incoming/D-TMP-PD513a.md)** — Provisional');
    // Compare the ENTRY lines, not the bare ids: the preamble cites D-070 and D-078 in prose, so
    // indexOf('D-070') finds the explanation rather than the listing.
    expect(out.indexOf('- **[D-TMP-PD513a]')).toBeLessThan(out.indexOf('- **[D-070]'));
  });

  it('does not call them draft or pending — the id is provisional, the decision is binding', () => {
    const out = renderDecisionsIndex([decision(70, 'n')], [provisional(513, 'p')]);
    expect(out).toContain('Awaiting a number');
    expect(out).toContain('binding');
    // Word-boundary, not substring: "appending" in the preamble contains "pending". The words to
    // keep out are the ones that invite an agent to treat a merged decision as arguable (D-078).
    expect(out).not.toMatch(/\b(draft|pending|proposed)\b/i);
  });

  it('omits the section entirely when the inbox is empty', () => {
    expect(renderDecisionsIndex([decision(70, 'n')], [])).not.toContain('Awaiting a number');
  });
});

describe('the real decision log', () => {
  // Loaded inside each test, never at describe-time: a throw while collecting takes the whole file
  // down and reports "no tests", which is red but anonymous. Inside a test, the thrown message —
  // which names both colliding paths — is the failure output.

  // This is the collision guard. Two branches CAN both add a D-071: different slugs make different
  // paths, so git merges both cleanly and silently, exactly as it did for the two D-056s that sat
  // in the log for three weeks. Nothing on either branch can see the other. This test runs over the
  // MERGED tree, which is the only place both are visible at once.
  it('parses, with no duplicate ids and no malformed files', () => {
    const decisions = loadDecisions(REPO_ROOT);
    expect(decisions.length).toBeGreaterThan(60);
    expect(new Set(decisions.map((d) => d.num)).size).toBe(decisions.length);
  });

  it('DECISIONS.md is in sync — regenerate with `npm run decisions:index`', () => {
    const onDisk = readFileSync(path.join(REPO_ROOT, DECISIONS_INDEX), 'utf8');
    expect(onDisk).toBe(renderDecisionsIndex(loadDecisions(REPO_ROOT), loadProvisionalDecisions(REPO_ROOT)));
  });

  it('the real inbox parses, and every provisional decision reaches the index', () => {
    // Same shape of guard as the duplicate-id test above, for the other half of the log: a file in
    // the inbox that nobody can parse is a decision nobody will ever number.
    const incoming = loadProvisionalDecisions(REPO_ROOT);
    const onDisk = readFileSync(path.join(REPO_ROOT, DECISIONS_INDEX), 'utf8');
    for (const d of incoming) expect(onDisk).toContain(`](${d.file})`);
  });

  it('no numbered decision was written by hand into DECISIONS/incoming/', () => {
    // The failure this catches is an author half-following the convention: right directory, old
    // habit of allocating a number. loadProvisionalDecisions throws on it, so reaching here is pass.
    expect(() => loadProvisionalDecisions(REPO_ROOT)).not.toThrow();
  });

  it('still has the ids the rest of the repo cites', () => {
    // Spot-check load-bearing ones rather than all ~70: D-046 (hand-off safety net) and D-047
    // (path-guard) are cited from CI, code, and prompts, and D-024 from a build file.
    const ids = new Set(loadDecisions(REPO_ROOT).map((d) => d.id));
    for (const id of ['D-001', 'D-024', 'D-046', 'D-047', 'D-070']) expect(ids).toContain(id);
  });
});
