import { z } from 'zod';
import { ROBOT_MAX_TURNS_LIMIT, coerceTicketStatus } from '@dashboard/shared';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { RefineProposal } from '@dashboard/shared';

/**
 * The `propose_commit` SDK tool (D-044, PD-269). The agent-worker NEVER writes tickets — when a
 * refine session has converged it calls this tool with a structured plan, which hands the proposal to
 * the `onProposal` callback (the refine loop persists it as a `refine_proposal` event). Steve
 * then approves on the board and the SERVER does the writes. Two modes:
 *   - refine_in_place: rewrite this ticket's body + route it (lane/assignee).
 *   - decompose: split into children; the server closes+links the parent (D-036).
 * Robot-bound targets SHOULD be Ready-shaped (## Context / ## Task / ## Done When /
 * ## Out of scope, PD-177) so they are Ready the moment they're queued (D-058).
 */

// The retired `prioritized` lane (D-080) is no longer accepted here. It used to be kept in
// the input enum so an un-redeployed worker's proposal wasn't lost over a lane name — but PD-510
// makes the approval ignore `status` entirely, so there is nothing left for the tolerance to save.
// A stale agent that emits it now gets an immediate, self-correcting tool error instead of a value
// that is quietly folded and then discarded anyway.
//
// `queue` stays in the enum on purpose: `queueLaneError` below turns it into an instructive refusal
// ("Refine does not dispatch"), which teaches more than a bare zod enum failure would.
const STATUS = z.enum([
  'backlog',
  'queue',
  'completed',
  'closed',
]);
const ASSIGNEE = z.enum(['steve', 'robot']).nullable();

// PD-432: the estimated ceiling. Bounded here as well as at the write boundary so a bad estimate
// is rejected while the agent can still see the error and re-propose, rather than at approval time.
const MAX_TURNS = z.number().int().min(1).max(ROBOT_MAX_TURNS_LIMIT).nullable();

// D-080: no `priority` field, on a child or on the parent. Priority is an Epic property that
// cascades to members, so a Ticket-level priority has nowhere to land — the write path overrides it
// from the Epic. Offering the field would have the agent spend turns on a value that is discarded
// without telling it, which is worse than not offering it (PD-510).
const CHILD = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  status: STATUS,
  assignee: ASSIGNEE.optional(),
  maxTurns: MAX_TURNS.optional(),
});

// Raw Zod shape (not z.object) — the SDK's tool() wants the shape.
const PROPOSE_COMMIT_SHAPE = {
  mode: z.enum(['refine_in_place', 'decompose']),
  body: z.string().optional(),
  status: STATUS.optional(),
  assignee: ASSIGNEE.optional(),
  maxTurns: MAX_TURNS.optional(),
  children: z.array(CHILD).optional(),
  rationale: z.string().optional(),
};

const DESCRIPTION = [
  'Propose the commit for this Refine session once you and Steve have converged. Do NOT call',
  'until the plan is concrete. You never write tickets — this records a proposal Steve approves.',
  'mode "refine_in_place": provide the rewritten `body` (+ optional `assignee`)',
  'for THIS ticket. mode "decompose": provide `children` (each title/body/status/assignee);',
  'the parent is then closed and linked to them — EXCEPT when the parent is an Epic, where the same',
  'decompose is reinterpreted as Populate (D-058): children become members of the Epic and the Epic',
  'stays open (no close, no split).',
  'There is NO priority field: priority belongs to the Epic and cascades to its members, so a',
  'Ticket-level priority has nowhere to land. If the plan implies a different urgency, say so in',
  '`rationale` and let Steve price the Epic.',
  'DO NOT route into a queue lane. `status` is "backlog"',
  '(or omit to leave it unchanged) — approval never moves a ticket between lanes anyway.',
  'Refine shapes tickets; it does NOT dispatch them (D-057):',
  "approval never queues, and Steve moves a ticket into the Robot's / Steve's Queue himself",
  'afterwards. Use `assignee` ("robot" | "steve" | null) to hint who should do the work. A ticket',
  'you intend for the robot MUST still carry a Robot-shaped body — the four sections ## Context,',
  '## Task, ## Done When, ## Out of scope — so Steve can queue it as-is.',
  'OPTIONAL `maxTurns` (PD-432): a conservative estimate of the turns a ticket needs, which raises',
  'that ticket\'s ceiling above the default. DECOMPOSING REMAINS THE PREFERRED MOVE — only set it',
  'when you have argued in `rationale` that the work genuinely cannot be split further, and estimate',
  'conservatively. Omit it for ~every ticket.',
].join(' ');

/** The queue lane the agent must not route into (D-057/D-058): entering the queue is Steve's
 *  explicit, post-approval act, not something Refine proposes. Also rejects the legacy pre-D-058
 *  queue lanes (`robot_queue`/`steve_queue`, PD-417) — an un-redeployed agent may still emit them,
 *  and they'd otherwise create an orphaned invalid lane on approval. */
function queueLaneError(where: string, status: string | undefined): string | null {
  if (status === 'queue' || status === 'robot_queue' || status === 'steve_queue') {
    return `${where} routes into a queue lane ("${status}"), but Refine does not queue tickets (D-057) — approval never dispatches; Steve queues explicitly (Approve & queue, or a board drag). Use "backlog" (or omit to leave the lane unchanged), and set \`assignee\` to hint who should do it.`;
  }
  return null;
}

/** The fully-qualified tool name the SDK exposes (server key `refine` + tool name). */
export const PROPOSE_TOOL_NAME = 'mcp__refine__propose_commit';

/** The mode↔fields shape that Zod (optional-everything) can't express. Zod makes `children`
 *  and `body` unconditionally optional regardless of `mode`, so a `decompose` with no children
 *  (or a `refine_in_place` with no body) passes tool validation and is only caught much later at
 *  approval time — surfacing to Steve as a confusing "invalid proposal" instead of to the agent
 *  as an immediate, self-correcting tool error. Enforce the invariant here at the call boundary.
 *  Returns an instructive error string, or null when the proposal is well-formed. */
export function validateProposalShape(proposal: RefineProposal): string | null {
  if (proposal.mode === 'decompose') {
    if (!proposal.children || proposal.children.length === 0) {
      return 'decompose requires a non-empty `children` array — you set mode "decompose" but attached no children. Re-call with each child ticket (title/body/status/assignee).';
    }
    for (const c of proposal.children) {
      const err = queueLaneError(`child "${c.title}"`, c.status);
      if (err) return err;
    }
  } else if (proposal.mode === 'refine_in_place') {
    if (proposal.body === undefined) {
      return 'refine_in_place requires the rewritten `body` for this ticket — you set mode "refine_in_place" but attached no body. Re-call with the full rewritten body.';
    }
    const err = queueLaneError('`status`', proposal.status);
    if (err) return err;
  }
  return null;
}

/**
 * Build the in-process MCP server exposing `propose_commit`. `onProposal` runs synchronously
 * in the agent-worker when the agent calls the tool (it persists the proposal to the shared DB).
 */
export function buildProposeToolServer(onProposal: (proposal: RefineProposal) => void) {
  const proposeCommit = tool(
    'propose_commit',
    DESCRIPTION,
    PROPOSE_COMMIT_SHAPE,
    async (args) => {
      const proposal: RefineProposal = {
        mode: args.mode,
        ...(args.body !== undefined ? { body: args.body } : {}),
        // The proposal still records the lane the agent asked for, because it is part of what was
        // proposed and belongs in the event log — but nothing downstream acts on it: PD-510 makes
        // approval leave the lane alone, and creates every decompose child in `backlog`. The
        // `coerceTicketStatus` fold is now belt-and-braces (the enum above already excludes every
        // retired lane) and is kept only so a proposal reconstructed from older stored JSON, which
        // predates that enum, still normalizes rather than carrying a dead lane forward.
        ...(args.status !== undefined
          ? { status: coerceTicketStatus(args.status) ?? 'backlog' }
          : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
        ...(args.children !== undefined
          ? {
              children: args.children.map((c) => ({
                ...c,
                assignee: c.assignee ?? null,
                // Same fold as the parent status above, and equally advisory — the approval
                // creates every child in `backlog` whatever this says (PD-510).
                status: coerceTicketStatus(c.status) ?? 'backlog',
              })),
            }
          : {}),
        ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
      };
      const invalid = validateProposalShape(proposal);
      if (invalid) {
        return {
          content: [{ type: 'text' as const, text: `Proposal NOT recorded — ${invalid}` }],
          isError: true,
        };
      }
      onProposal(proposal);
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Proposal recorded — it is now awaiting Steve’s approval on the board.',
          },
        ],
      };
    },
  );

  return createSdkMcpServer({ name: 'refine', version: '0.0.1', tools: [proposeCommit] });
}
