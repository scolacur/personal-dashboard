import { describe, it, expect } from 'vitest';
import { buildTaskPrompt, robotSystemPrompt, VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER, MEMORY_RUNS_DIR } from './prompt';

const base = {
  title: 'Add a thing',
  body: '## Context\nx\n## Task\ny\n## Done When\nz\n## Out of scope\nw',
  branch: 'robot/220',
  repo: 'scolacur/personal-dashboard',
  issueNumber: 220 as number | null,
  proxy: 'http://egress-proxy:3128',
};

describe('robotSystemPrompt', () => {
  it('establishes the Robot role and the no-touch-schema/scope rules', () => {
    const s = robotSystemPrompt();
    expect(s).toMatch(/You are a Robot/);
    expect(s).toMatch(/Stay strictly within this one ticket/);
    expect(s).toMatch(/MUST ship with vitest tests/);
  });

  // PD-306: orientation rides the SYSTEM prompt (stable across tickets ⇒ prompt-cacheable), so it
  // must actually be carried through rather than silently dropped.
  it('appends the injected orientation after the rules, keeping both', () => {
    const s = robotSystemPrompt('## Project orientation\n\nPROJECT.md says hello.');
    expect(s).toMatch(/You are a Robot/);
    expect(s).toContain('PROJECT.md says hello.');
    expect(s.indexOf('You are a Robot')).toBeLessThan(s.indexOf('PROJECT.md says hello.'));
  });

  it('emits only the rules when there is no orientation, with no dangling separator', () => {
    expect(robotSystemPrompt()).toBe(robotSystemPrompt(''));
    expect(robotSystemPrompt().trimEnd()).toBe(robotSystemPrompt());
  });
});

describe('buildTaskPrompt', () => {
  it('embeds the ticket title + body and the branch', () => {
    const p = buildTaskPrompt(base);
    expect(p).toContain('# Ticket: Add a thing');
    expect(p).toContain('## Done When');
    expect(p).toContain('robot/220');
  });

  it('drives the D-046 hand-off: verify → marker → commit → push → PR → manifest', () => {
    const p = buildTaskPrompt(base);
    expect(p).toContain('npm run verify');
    expect(p).toContain(VERIFY_OK_MARKER);
    expect(p).toContain('git add -A');
    expect(p).toContain('gh auth setup-git'); // wire push auth to the token before pushing
    expect(p).toContain('git -c http.proxy=http://egress-proxy:3128 push -u origin robot/220');
    expect(p).toContain('gh pr create --repo scolacur/personal-dashboard --base main --head robot/220');
    expect(p).toContain(SCM_JSON);
  });

  it('makes the run write its own memory file, in the per-run inbox, before committing (PD-306)', () => {
    const p = buildTaskPrompt(base);
    expect(p).toContain(`${MEMORY_RUNS_DIR}/$(date +%F)-robot-220.md`);
    expect(p).toMatch(/Worth remembering/);
    // Ordering is load-bearing: written after verify, before the commit, or it misses the commit.
    // Anchored on the sub-step headings — `git add -A` also appears in Step 1's CLAUDE.md warning.
    expect(p.indexOf(MEMORY_RUNS_DIR)).toBeGreaterThan(p.indexOf('1. **Verify.**'));
    expect(p.indexOf(MEMORY_RUNS_DIR)).toBeLessThan(p.indexOf('3. **Commit**'));
  });

  // The shared day file and the index are the conflict shape D-070 removed for decisions; a Robot
  // must never reintroduce it. This is the instruction that keeps it out.
  it('forbids the Robot from touching the curated day file or the memory index', () => {
    const p = buildTaskPrompt(base);
    expect(p).toMatch(/Never edit `MEMORY\/MEMORY\.md` or a `MEMORY\/YYYY-MM-DD\.md`/);
  });

  it('tells the Robot to ignore CLAUDE.md, and says why rather than just asserting it', () => {
    const p = buildTaskPrompt(base);
    expect(p).toMatch(/Ignore `CLAUDE\.md`/);
    expect(p).toMatch(/you are in one/); // the worktree contradiction
    expect(p).toMatch(/you cannot see\s+the board/); // the DB-blind contradiction (line-wrapped)
  });

  it('does not spend turns re-reading what it was already given', () => {
    expect(buildTaskPrompt(base)).toMatch(/do NOT spend turns re-reading them/);
  });

  it('carries memory + decisions into the PR envelope, not just the branch', () => {
    expect(buildTaskPrompt(base)).toMatch(/\*\*Memory \/ Decisions:\*\*/);
  });

  it('tells the Robot how to park for a human on a genuine ambiguity (C2 ask_human)', () => {
    const p = buildTaskPrompt(base);
    expect(p).toContain(ASK_HUMAN_MARKER);
    expect(p).toMatch(/only a human can resolve|genuine ambiguity/i);
    expect(p).toMatch(/not a failure/i);
  });

  it('is DB-blind: never tells the Robot to relabel or change ticket/board state', () => {
    const p = buildTaskPrompt(base);
    expect(p).toMatch(/Do NOT change any GitHub labels or ticket state/);
    expect(p).not.toMatch(/robot_reset|agent_state|dashboard\.db/);
  });

  it('includes Closes #N when linked, omits it when not', () => {
    expect(buildTaskPrompt(base)).toContain('Closes #220');
    expect(buildTaskPrompt({ ...base, issueNumber: null })).not.toContain('Closes #');
  });

  it('omits the inline git proxy flag when there is no proxy (dev)', () => {
    const p = buildTaskPrompt({ ...base, proxy: '' });
    expect(p).toContain('git push -u origin robot/220');
    expect(p).not.toContain('http.proxy');
  });

  // ---- C5 (PD-346) resume-aware prompting ----

  it('always includes the Step 0 resume check (read PR feedback / resolve conflict) for rework', () => {
    const p = buildTaskPrompt(base);
    expect(p).toContain('## Step 0 — Resuming an earlier attempt?');
    expect(p).toContain('gh pr view robot/220 --repo scolacur/personal-dashboard --json number');
    expect(p).toMatch(/reviews,comments/); // read the feedback off the PR
    expect(p).toMatch(/git .*merge origin\/main/); // resolve a conflict
    expect(p).toMatch(/do NOT open a second/i); // push updates the same PR
  });

  it('injects the human ask_human answer when resuming, and omits the block otherwise', () => {
    const withAnswer = buildTaskPrompt({
      ...base,
      resume: { askHumanQuestion: 'Design A or B?', askHumanAnswer: 'Go with B.' },
    });
    expect(withAnswer).toContain('A human answered your earlier question');
    expect(withAnswer).toContain('Design A or B?');
    expect(withAnswer).toContain('Go with B.');
    expect(withAnswer).toMatch(/Do NOT ask it again/i);

    // No resume context ⇒ no answer block.
    expect(buildTaskPrompt(base)).not.toContain('A human answered your earlier question');
  });
});
