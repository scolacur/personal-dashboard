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
  sampleOrientation,
  sampleRobotTaskPrompt,
  type AgentProfile,
  type AgentType,
} from '@dashboard/shared';

export type { AgentProfile, AgentType };

/**
 * The Agent Glossary's content (PD-306).
 *
 * **Nothing here is a transcription.** Every prompt is produced by calling the same builder the
 * worker calls, from `packages/shared/src/agent-prompts.ts`, with placeholder inputs. Changing an
 * agent's prompt changes this modal in the same commit, with no step that anyone can forget — a
 * copied prompt would be wrong within a week and wrong in the least detectable way, since nothing
 * fails when documentation drifts from behaviour.
 *
 * (PD-500 tracks the next step: editing these prompts *from* the modal.)
 */

export interface PromptSection {
  title: string;
  /** What this text is and when the agent receives it. */
  note: string;
  text: string;
}

export interface AgentGlossaryView {
  profile: AgentProfile;
  sections: PromptSection[];
}

/** Placeholders the glossary substitutes for per-run values, listed so the reader knows which
 *  angle-bracket tokens are variables rather than literal prompt text. */
export const PROMPT_PLACEHOLDERS: { token: string; meaning: string }[] = [
  { token: '<TICKET TITLE>', meaning: "The ticket's title, as shown on the board." },
  { token: '<TICKET BODY>', meaning: 'The full ticket body — Context / Task / Done When / Out of scope.' },
  { token: 'robot/<TICKET ID>', meaning: "The run's branch, one per ticket." },
  { token: '<OWNER/REPO>', meaning: "The project's GitHub repo." },
  { token: '<EGRESS PROXY URL, when set>', meaning: 'Squid proxy, passed inline to git. Empty in dev.' },
  { token: '<VERBATIM CONTENTS OF …>', meaning: 'The named file is injected whole, exactly as it is on the branch.' },
];

function robotSections(): PromptSection[] {
  return [
    {
      title: 'System prompt — standing rules',
      note: 'Sent on every run, before anything else. These are the rules that do not vary by ticket.',
      text: robotSystemPrompt(),
    },
    {
      title: 'System prompt — injected orientation',
      note:
        'Appended to the rules above. The Robot runs NO command to get this (D-071) — the loop reads the files off its worktree and hands them over, so orientation cannot be skipped. It rides the system prompt because it is identical for every ticket, which keeps it in the prompt cache.',
      text: sampleOrientation(),
    },
    {
      title: 'Task prompt — the ticket and the hand-off sequence',
      note: 'The user turn, rebuilt per run. Step 3 is the D-046 hand-off and its order is load-bearing.',
      text: sampleRobotTaskPrompt(),
    },
    {
      title: 'Task prompt — extra block on a re-dispatch',
      note:
        'Prepended only when the loop re-dispatches a ticket that parked with an ask_human question (C5/PD-346). The Robot is DB-blind, so the human\'s answer has to be handed to it directly.',
      text: resumeBlockOnly(),
    },
  ];
}

/**
 * The resume block alone — the difference between a fresh task prompt and a re-dispatched one.
 *
 * Derived by diffing the two rather than re-typing it: the block is built inside `buildTaskPrompt`,
 * so this stays correct if its wording changes.
 */
export function resumeBlockOnly(): string {
  const fresh = sampleRobotTaskPrompt();
  const resumed = sampleRobotTaskPrompt(SAMPLE_RESUME_CONTEXT);
  const freshLines = fresh.split('\n');
  const resumedLines = resumed.split('\n');
  let head = 0;
  while (head < freshLines.length && freshLines[head] === resumedLines[head]) head++;
  const extra = resumedLines.length - freshLines.length;
  return resumedLines.slice(head, head + extra).join('\n').trim();
}

export function agentGlossaryView(id: AgentType): AgentGlossaryView {
  const profile = AGENT_PROFILES[id];
  if (id === 'robot') return { profile, sections: robotSections() };
  if (id === 'refine') {
    return {
      profile,
      sections: [
        {
          title: 'System prompt',
          note: `Sent on every Refine session. The turn ceiling it quotes (${ROBOT_MAX_TURNS_DEFAULT}) is the Robot's, not its own — Refine sizes tickets against the budget that will run them.`,
          text: refineSystemPrompt(SAMPLE_CONTEXT_PACK, ROBOT_MAX_TURNS_DEFAULT),
        },
      ],
    };
  }
  if (id === 'audit') {
    return {
      profile,
      sections: [
        {
          title: 'System prompt',
          note: 'Sent on every scheduled audit pass. The ticket list itself is appended as the user turn.',
          text: auditSystemPrompt(SAMPLE_CONTEXT_PACK),
        },
      ],
    };
  }
  return {
    profile,
    sections: [
      {
        title: 'System prompt',
        note: "Sent on every evaluation pass, after a Robot hands off its PR. The rubric is adapted from Core's Oracle — a Robot ticket is Ready-shaped, so `## Done When` is the acceptance list and `## Out of scope` is the constraint list (D-076).",
        text: evaluatorSystemPrompt(SAMPLE_CONTEXT_PACK),
      },
      {
        title: 'Per-PR prompt',
        note: 'The user turn, one per PR. The diff is fetched by the worker with the read-only token; the Evaluator never touches GitHub itself.',
        text: buildEvaluatorPrompt(SAMPLE_EVALUATOR_PROMPT_INPUT),
      },
    ],
  };
}

/** Every agent, in the order the glossary tabs them. Driven by AGENT_TYPES, so a fourth agent
 *  added in `packages/shared` gets a tab without touching the component. */
export const AGENT_GLOSSARY_VIEWS: AgentGlossaryView[] = AGENT_TYPES.map(agentGlossaryView);
