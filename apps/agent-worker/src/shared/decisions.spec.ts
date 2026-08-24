import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISIONS_INDEX,
  EXAMPLE_TICKET_PREFIX,
  findRepoRoot,
  isExampleId,
  loadDecisions,
  loadProvisionalDecisions,
  nextDecisionId,
  parseDecisionFilename,
  parseDecisionHeading,
  parseProvisionalFilename,
  parseProvisionalHeading,
  renderDecisionsIndex,
  renderInjectedIndex,
  renderProvisionalSection,
  type Decision,
  type ProvisionalDecision,
} from './decisions';

const REPO_ROOT = findRepoRoot(__dirname);

function decision(num: number, title: string, slug = 'x'): Decision {
  const id = `D-${String(num).padStart(3, '0')}`;
  return { id, num, slug, title, file: `DECISIONS/${id}-${slug}.md` };
}

function provisional(ticketNum: number, title: string, letter = 'a'): ProvisionalDecision {
  const id = `D-TMP-EG${ticketNum}${letter}`;
  return { id, ticketPrefix: 'EG', ticketNum, letter, title, file: `DECISIONS/incoming/${id}.md` };
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
    expect(parseProvisionalFilename('D-TMP-EG383a.md')).toEqual({
      id: 'D-TMP-EG383a',
      ticketPrefix: 'EG',
      ticketNum: 383,
      letter: 'a',
    });
  });

  it('rejects anything that is not D-TMP-<TICKET><letter>.md', () => {
    expect(parseProvisionalFilename('D-TMP-PD383.md')).toBeNull(); // no letter
    expect(parseProvisionalFilename('D-TMP-pd383a.md')).toBeNull(); // lowercase prefix
    expect(parseProvisionalFilename('D-TMP-EG383a-with-slug.md')).toBeNull();
    expect(parseProvisionalFilename('D-079-numbered.md')).toBeNull();
    expect(parseProvisionalFilename('.gitkeep')).toBeNull();
  });

  it('can never be mistaken for a numbered decision, in either direction', () => {
    // This is what makes `grep -rl 'D-TMP-'` a safe blind rewrite (D-078): the two namespaces
    // cannot overlap, so the cycle cannot rewrite a real citation by accident.
    expect(parseDecisionFilename('D-TMP-EG383a.md')).toBeNull();
    expect(parseProvisionalFilename('D-046-sortie-after-run-safety-net.md')).toBeNull();
  });
});

describe('parseProvisionalHeading', () => {
  it('reads the title off the first line', () => {
    expect(parseProvisionalHeading('# D-TMP-EG383a: The Epic is the unit of dispatch\n\n**Decision:**')).toEqual({
      id: 'D-TMP-EG383a',
      ticketPrefix: 'EG',
      ticketNum: 383,
      letter: 'a',
      title: 'The Epic is the unit of dispatch',
    });
  });

  it('returns null when the first line is not a well-formed provisional heading', () => {
    expect(parseProvisionalHeading('## D-TMP-EG383a: Wrong level\n')).toBeNull();
    expect(parseProvisionalHeading('# D-TMP-EG383a:\n')).toBeNull();
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
    const out = renderDecisionsIndex([decision(70, 'Newer'), decision(12, 'Older')]);
    expect(out).toContain('- **[D-070](DECISIONS/D-070-x.md)** — Newer');
    expect(out.indexOf('D-070')).toBeLessThan(out.indexOf('D-012'));
  });

  it('says it is generated, so nobody hand-edits a file that gets overwritten', () => {
    expect(renderDecisionsIndex([decision(1, 'a')])).toContain('generated');
  });

  it('tells an author to write the inbox, never a D-NNN file by hand', () => {
    const out = renderDecisionsIndex([decision(1, 'a')]);
    expect(out).toContain('DECISIONS/incoming/D-TMP-<TICKET><letter>.md');
    expect(out).toContain('never a');
  });

  it('does NOT list provisional decisions — that is what stops authoring PRs colliding', () => {
    // PD-551: they were listed here briefly and every authoring PR then regenerated the index and
    // inserted a line into the same block, so two concurrent authors collided on a generated file.
    // Targets ENTRY lines, not the string: the preamble legitimately says `D-TMP-<TICKET><letter>`
    // as the authoring instruction. What must not appear is a listed provisional decision.
    const out = renderDecisionsIndex([decision(70, 'Numbered')]);
    expect(out).not.toMatch(/^- \*\*\[D-TMP-/m);
    expect(out).not.toContain('## Awaiting a number');
  });

  it('says where the unnumbered ones are, so their absence does not mislead a reader', () => {
    const out = renderDecisionsIndex([decision(70, 'n')]);
    expect(out).toContain('DECISIONS/incoming/');
    expect(out).toContain('binding');
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
    expect(onDisk).toBe(renderDecisionsIndex(loadDecisions(REPO_ROOT)));
  });

  it('the real inbox parses, and every provisional decision reaches the INJECTED index', () => {
    // Same shape of guard as the duplicate-id test above, for the other half of the log. It checks
    // the injected index, not the file on disk: since PD-551 the committed file deliberately omits
    // these, and asserting against it would pin the bug rather than the fix.
    const incoming = loadProvisionalDecisions(REPO_ROOT);
    const injected = renderInjectedIndex(loadDecisions(REPO_ROOT), incoming);
    for (const d of incoming) expect(injected).toContain(`](${d.file})`);
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

// PD-548. The example namespace works only while nothing real is authored under it: an `EG` file in
// the inbox would give the rewriter a genuine mapping for an id that docs and fixtures use freely,
// and every one of them would be rewritten. This runs over the REAL inbox on every CI run.
//
// It lives here rather than in `loadProvisionalDecisions` on purpose — that loader is also what the
// tests point at temp inboxes full of deliberately-`EG` fixtures, so a guard inside it would forbid
// the very fixtures the namespace exists to make safe.
describe('the real decision inbox', () => {
  it('never contains a decision authored under the reserved example prefix', () => {
    const offenders = loadProvisionalDecisions(REPO_ROOT)
      .filter((d) => d.ticketPrefix === EXAMPLE_TICKET_PREFIX)
      .map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  it('every inbox id is one a real ticket could have produced', () => {
    for (const d of loadProvisionalDecisions(REPO_ROOT)) {
      expect(isExampleId(d.id)).toBe(false);
    }
  });
});

describe('renderInjectedIndex — what an agent actually reads', () => {
  it('carries the numbered decisions AND the provisional ones', () => {
    // The committed file omits provisional decisions so authoring cannot conflict; the injected
    // index must still include them, or an agent re-litigates a decision that merged an hour ago
    // (D-071). Splitting the two renderers is what buys both.
    const out = renderInjectedIndex([decision(70, 'Numbered')], [provisional(513, 'Provisional')]);
    expect(out).toContain('- **[D-070](DECISIONS/D-070-x.md)** — Numbered');
    expect(out).toContain('- **[D-TMP-EG513a](DECISIONS/incoming/D-TMP-EG513a.md)** — Provisional');
  });

  it('is exactly the committed file when the inbox is empty', () => {
    // No stray heading, no trailing section — an empty inbox must not change the injected text.
    expect(renderInjectedIndex([decision(70, 'n')], [])).toBe(renderDecisionsIndex([decision(70, 'n')]));
  });

  it('does not call them draft or pending — the id is provisional, the decision is binding', () => {
    const out = renderInjectedIndex([decision(70, 'n')], [provisional(513, 'p')]);
    expect(out).toContain('Awaiting a number');
    expect(out).not.toMatch(/\b(draft|pending|proposed)\b/i);
  });
});

describe('renderProvisionalSection', () => {
  it('is empty for an empty inbox, so callers can concatenate unconditionally', () => {
    expect(renderProvisionalSection([])).toBe('');
  });

  it('lists each provisional decision with a link to its file', () => {
    expect(renderProvisionalSection([provisional(513, 'Memory inbox')])).toContain(
      '- **[D-TMP-EG513a](DECISIONS/incoming/D-TMP-EG513a.md)** — Memory inbox',
    );
  });
});
