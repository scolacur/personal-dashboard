import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  DECISIONS_INDEX,
  findRepoRoot,
  loadDecisions,
  parseDecisionFilename,
  parseDecisionHeading,
  renderDecisionsIndex,
  type Decision,
} from './decisions';

const REPO_ROOT = findRepoRoot(__dirname);

function decision(num: number, title: string, slug = 'x'): Decision {
  const id = `D-${String(num).padStart(3, '0')}`;
  return { id, num, slug, title, file: `DECISIONS/${id}-${slug}.md` };
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
describe('renderDecisionsIndex', () => {
  it('lists newest first, with a link to each file', () => {
    const out = renderDecisionsIndex([decision(70, 'Newer'), decision(12, 'Older')]);
    expect(out).toContain('- **[D-070](DECISIONS/D-070-x.md)** — Newer');
    expect(out.indexOf('D-070')).toBeLessThan(out.indexOf('D-012'));
  });

  it('says it is generated, so nobody hand-edits a file that gets overwritten', () => {
    expect(renderDecisionsIndex([decision(1, 'a')])).toContain('generated');
  });

  it('points an author at the allocator, not at a number they could pick', () => {
    // The header is the most-read instruction in the repo — it is at the top of the file anyone
    // opens to look a decision up. If it still described the inbox, a reader following it would
    // author into a directory that no longer exists.
    const out = renderDecisionsIndex([decision(1, 'A')]);
    expect(out).toContain('POST /api/decisions/allocate');
    expect(out).toContain('Never pick a number yourself');
    expect(out).not.toContain('D-TMP-');
    expect(out).not.toContain('incoming');
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

  it('has no decision inbox — every decision is numbered when it is written (PD-560)', () => {
    // The inbox and its numbering cycle are gone. A reappearing `DECISIONS/incoming/` means someone
    // followed a stale instruction and wrote a `D-TMP-` file that nothing will ever number, so it
    // would sit uncited and invisible to the index rather than failing loudly.
    expect(existsSync(path.join(REPO_ROOT, 'DECISIONS/incoming'))).toBe(false);
  });

  it('every decision file is numbered — no provisional ids left in DECISIONS/', () => {
    const decisions = loadDecisions(REPO_ROOT);
    expect(decisions.every((d) => /^D-\d{3}$/.test(d.id))).toBe(true);
  });

  it('still has the ids the rest of the repo cites', () => {
    // Spot-check load-bearing ones rather than all ~70: D-046 (hand-off safety net) and D-047
    // (path-guard) are cited from CI, code, and prompts, and D-024 from a build file.
    const ids = new Set(loadDecisions(REPO_ROOT).map((d) => d.id));
    for (const id of ['D-001', 'D-024', 'D-046', 'D-047', 'D-070']) expect(ids).toContain(id);
  });
});