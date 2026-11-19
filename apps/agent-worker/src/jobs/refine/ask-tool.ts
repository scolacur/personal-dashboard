import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { REFINE_ROUND_LIMITS, validateQuestionRound, type RefineQuestionRound } from '@dashboard/shared';

/**
 * The `ask_questions` SDK tool (PD-744, D-096 §4–5). The Refine agent asks Steve through this
 * instead of prose, so the questions can be answered with clicks — on the ticket page and in the
 * Decisions inbox. The handler validates the round (`validateQuestionRound`, shared with the server)
 * and hands it to `onRound`; the refine loop attaches it to this turn's `refine_agent` event once
 * the turn completes cleanly. A malformed round comes back as an instructive tool error, the same
 * self-correcting pattern as `propose_commit`.
 */

/** The fully-qualified tool name the SDK exposes (server key `refine` + tool name). */
export const ASK_TOOL_NAME = 'mcp__refine__ask_questions';

const OPTION = z.object({
  label: z.string(),
  description: z.string(),
});

const QUESTION = z.object({
  id: z.string(),
  question: z.string(),
  why: z.string(),
  options: z.array(OPTION),
  recommended: z.number().int(),
});

const ASSUMPTION = z.object({
  text: z.string(),
  source: z.string(),
});

// Raw Zod shape (not z.object) — the SDK's tool() wants the shape. Bounds are enforced by
// validateQuestionRound rather than zod, so the agent gets a sentence instead of a schema dump.
const ASK_QUESTIONS_SHAPE = {
  questions: z.array(QUESTION),
  assumptions: z.array(ASSUMPTION).optional(),
};

const L = REFINE_ROUND_LIMITS;

export const ASK_DESCRIPTION = [
  'Ask Steve your questions for this round. Use this INSTEAD of writing questions in your reply:',
  'he answers with clicks on the board, so anything asked only in prose is easy to miss.',
  `Send ${L.minQuestions}–${L.maxQuestions} questions, each with a short unique \`id\`, the \`question\`, a one-line \`why\``,
  `(what the answer changes in the ticket), ${L.minOptions}–${L.maxOptions} \`options\` (each a short \`label\` plus a \`description\``,
  'that states the trade-off of picking it), and `recommended`: the 0-based index of the option you',
  'would choose. Steve can always type an Other answer, so do not add an "Other" option.',
  'Before asking, settle anything DECISIONS.md or PROJECT.md already answers. Put those in',
  '`assumptions` (each `text` plus the `source` it rests on) instead of asking them; Steve can',
  'overrule any one. Only genuine product calls are questions.',
  'Write every ticket or decision id with its title beside it, e.g. "PD-743 (Park a Refine',
  'session)" or "the Async Refine Epic (PD-742)": a bare id is rejected. Call it at most once per',
  'turn (a second call replaces the first), then end your turn with a short reply. Steve\'s answers',
  'arrive as your next message.',
].join(' ');

/** Build the tool. `onRound` runs synchronously in the agent-worker on a valid call. */
export function buildAskQuestionsTool(onRound: (round: RefineQuestionRound) => void) {
  return tool('ask_questions', ASK_DESCRIPTION, ASK_QUESTIONS_SHAPE, async (args) => {
    const round: RefineQuestionRound = {
      questions: args.questions.map((q) => ({
        id: q.id.trim(),
        question: q.question,
        why: q.why,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        recommended: q.recommended,
      })),
      assumptions: (args.assumptions ?? []).map((a) => ({ text: a.text, source: a.source })),
    };
    const invalid = validateQuestionRound(round);
    if (invalid) {
      return {
        content: [{ type: 'text' as const, text: `Questions NOT sent — ${invalid}` }],
        isError: true,
      };
    }
    onRound(round);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Questions recorded (${round.questions.length}). Steve will see them as a form when this turn ends. End your turn now with a one- or two-sentence reply; do not repeat the questions in prose.`,
        },
      ],
    };
  });
}
