import { describe, it, expect } from 'vitest';
import { buildTaskPrompt, robotSystemPrompt, VERIFY_OK_MARKER, SCM_JSON } from './prompt';

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

  it('is DB-blind: never tells the Robot to relabel or change ticket/board state', () => {
    const p = buildTaskPrompt(base);
    expect(p).toMatch(/Do NOT change any GitHub labels or ticket state/);
    expect(p).not.toMatch(/sortie:in-review|robot_queue|agent_state|dashboard\.db/);
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
});
