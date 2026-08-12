import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  AGENT_TYPES,
  ROBOT_MAX_TURNS_DEFAULT,
  SAMPLE_CONTEXT_PACK,
  SAMPLE_RESUME_CONTEXT,
  auditSystemPrompt,
  evaluatorSystemPrompt,
  buildEvaluatorPrompt,
  SAMPLE_EVALUATOR_PROMPT_INPUT,
  refineSystemPrompt,
  robotSystemPrompt,
  sampleRobotTaskPrompt,
} from '@dashboard/shared';
import { AGENT_GLOSSARY_VIEWS, agentGlossaryView, resumeBlockOnly } from './agent-glossary';

describe('the Agent Glossary', () => {
  it('has a tab for every agent that actually runs, driven by AGENT_TYPES', () => {
    // A fourth agent added in packages/shared gets a tab with no change here or in the component.
    expect(AGENT_GLOSSARY_VIEWS.map((v) => v.profile.id)).toEqual([...AGENT_TYPES]);
    expect(AGENT_TYPES).toEqual(['robot', 'refine', 'audit', 'evaluator']);
  });

  it('gives each agent its OWN prompt, not a neighbour’s', () => {
    // `agentGlossaryView` dispatches on id with a fallthrough. When `evaluator` was added, the
    // fallthrough silently rendered the AUDIT prompt under the Evaluator tab — every other
    // assertion here passed, because "has a prompt" was true and only the content was wrong.
    // Comparing tabs pairwise is what catches a mis-routed branch.
    const texts = AGENT_GLOSSARY_VIEWS.map((v) => v.sections.map((s) => s.text).join('\n'));
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('gives every agent a tagline, responsibilities, and at least one prompt', () => {
    for (const view of AGENT_GLOSSARY_VIEWS) {
      expect(view.profile.tagline).not.toBe('');
      expect(view.profile.responsibilities.length).toBeGreaterThan(0);
      expect(view.sections.length).toBeGreaterThan(0);
      for (const s of view.sections) expect(s.text.trim()).not.toBe('');
    }
  });
});

// This is the point of the whole feature. Each assertion compares the rendered section to the
// builder's own output, so a prompt change moves both together. If someone ever pastes prompt text
// into the UI instead of calling the builder, these fail.
describe('prompts are rendered from the real builders, not transcribed', () => {
  it("the Robot's standing rules are robotSystemPrompt() verbatim", () => {
    const section = agentGlossaryView('robot').sections.find((s) => s.title.includes('standing rules'));
    expect(section?.text).toBe(robotSystemPrompt());
  });

  it("the Robot's task prompt is buildTaskPrompt() with placeholders", () => {
    const section = agentGlossaryView('robot').sections.find((s) => s.title.includes('hand-off sequence'));
    expect(section?.text).toBe(sampleRobotTaskPrompt());
  });

  it("Refine's prompt is refineSystemPrompt() quoting the Robot's real turn ceiling", () => {
    const section = agentGlossaryView('refine').sections[0];
    expect(section.text).toBe(refineSystemPrompt(SAMPLE_CONTEXT_PACK, ROBOT_MAX_TURNS_DEFAULT));
    expect(section.text).toContain(String(ROBOT_MAX_TURNS_DEFAULT));
  });

  it("Audit's prompt is auditSystemPrompt() verbatim", () => {
    expect(agentGlossaryView('audit').sections[0].text).toBe(auditSystemPrompt(SAMPLE_CONTEXT_PACK));
  });
});

describe("the Robot's rendered prompts", () => {
  const sections = agentGlossaryView('robot').sections;
  const all = sections.map((s) => s.text).join('\n');

  it('show the injected orientation, with the real framing and headings', () => {
    const orientation = sections.find((s) => s.title.includes('orientation'))?.text ?? '';
    expect(orientation).toContain('## Project orientation');
    expect(orientation).toContain('ALREADY in your own dedicated git worktree');
    expect(orientation).toContain('PROJECT.md');
    expect(orientation).toContain('DECISIONS.md');
    expect(orientation).toContain('MEMORY');
  });

  it('carry the whole hand-off sequence, not an abridged version', () => {
    for (const step of ['npm run verify', '.robot/verify-ok', 'MEMORY/runs', 'git add -A', 'gh pr create', '.robot/scm.json']) {
      expect(all).toContain(step);
    }
  });

  it('use named placeholders wherever a real run has ticket-specific values', () => {
    expect(all).toContain('<TICKET TITLE>');
    expect(all).toContain('robot/<TICKET ID>');
    expect(all).toContain('<OWNER/REPO>');
    // A leaked real value would mean the sample was built from live data.
    expect(all).not.toContain('scolacur/personal-dashboard');
  });
});

describe('resumeBlockOnly', () => {
  // Derived by diffing a fresh prompt against a resumed one rather than re-typing the block, so
  // rewording it in buildTaskPrompt cannot leave a stale copy behind in the UI.
  it('is exactly the extra text a re-dispatched run receives', () => {
    const block = resumeBlockOnly();
    expect(block).toContain('A human answered your earlier question');
    expect(block).toContain(SAMPLE_RESUME_CONTEXT.askHumanQuestion as string);
    expect(block).toContain(SAMPLE_RESUME_CONTEXT.askHumanAnswer as string);
  });

  it('contains nothing that a fresh run already gets', () => {
    expect(sampleRobotTaskPrompt()).not.toContain(resumeBlockOnly());
    expect(resumeBlockOnly()).not.toContain('## Step 0');
  });

  it('reconstructs the resumed prompt when spliced back in', () => {
    const fresh = sampleRobotTaskPrompt();
    const resumed = sampleRobotTaskPrompt(SAMPLE_RESUME_CONTEXT);
    expect(resumed.replace(`${resumeBlockOnly()}\n\n`, '')).toBe(fresh);
  });
});

describe('agent profiles', () => {
  it('marks only the Robot as able to write', () => {
    expect(AGENT_PROFILES.robot.access).not.toBe('read-only');
    expect(AGENT_PROFILES.refine.access).toBe('read-only');
    expect(AGENT_PROFILES.audit.access).toBe('read-only');
  });

  it('cites the decisions behind each agent', () => {
    expect(AGENT_PROFILES.robot.decisions).toContain('D-055');
    expect(AGENT_PROFILES.refine.decisions).toContain('D-044');
    expect(AGENT_PROFILES.audit.decisions).toContain('D-045');
  });
});

describe("the Evaluator's tab", () => {
  const view = agentGlossaryView('evaluator');

  it('renders the real system prompt, not a transcription', () => {
    const section = view.sections.find((s) => s.title === 'System prompt');
    expect(section?.text).toBe(evaluatorSystemPrompt(SAMPLE_CONTEXT_PACK));
  });

  it('renders the real per-PR prompt', () => {
    const section = view.sections.find((s) => s.title === 'Per-PR prompt');
    expect(section?.text).toBe(buildEvaluatorPrompt(SAMPLE_EVALUATOR_PROMPT_INPUT));
  });

  it('is not the Audit prompt', () => {
    // The exact bug the fallthrough produced.
    for (const s of view.sections) expect(s.text).not.toBe(auditSystemPrompt(SAMPLE_CONTEXT_PACK));
  });
});
