import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { RefineProposal } from '@dashboard/shared';

/**
 * The `propose_commit` SDK tool (D-044, PD-269). The agent-worker NEVER writes tickets — when a
 * refine session has converged it calls this tool with a structured plan, which hands the proposal to
 * the `onProposal` callback (the refine loop persists it as a `refine_proposal` event). Steve
 * then approves on the board and the SERVER does the writes. Two modes:
 *   - refine_in_place: rewrite this ticket's body + route it (lane/assignee).
 *   - decompose: split into children; the server closes+links the parent (D-036).
 * Robot-bound targets MUST be isSortieReady-shaped (## Context / ## Task / ## Done When /
 * ## Out of scope, PD-177) or the server rejects the approval.
 */

const STATUS = z.enum([
  'backlog',
  'prioritized',
  'robot_queue',
  'steve_queue',
  'completed',
  'closed',
]);
const ASSIGNEE = z.enum(['steve', 'robot']).nullable();
const PRIORITY = z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']).nullable();

const CHILD = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  status: STATUS,
  assignee: ASSIGNEE.optional(),
  priority: PRIORITY.optional(),
});

// Raw Zod shape (not z.object) — the SDK's tool() wants the shape.
const PROPOSE_COMMIT_SHAPE = {
  mode: z.enum(['refine_in_place', 'decompose']),
  body: z.string().optional(),
  status: STATUS.optional(),
  assignee: ASSIGNEE.optional(),
  priority: PRIORITY.optional(),
  children: z.array(CHILD).optional(),
  rationale: z.string().optional(),
};

const DESCRIPTION = [
  'Propose the commit for this Refine session once you and Steve have converged. Do NOT call',
  'until the plan is concrete. You never write tickets — this records a proposal Steve approves.',
  'mode "refine_in_place": provide the rewritten `body` (+ optional `status`/`assignee`/`priority`)',
  'for THIS ticket. mode "decompose": provide `children` (each title/body/status/assignee/priority);',
  'the parent is then closed and linked to them. `priority` is P0–P5 (P0 most urgent) or null to',
  'leave unset — set it when the plan implies urgency (e.g. deferred follow-ons → P3). Any target',
  'routed to `robot_queue` MUST have a body with the four sections: ## Context, ## Task, ## Done',
  'When, ## Out of scope.',
].join(' ');

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
  } else if (proposal.mode === 'refine_in_place') {
    if (proposal.body === undefined) {
      return 'refine_in_place requires the rewritten `body` for this ticket — you set mode "refine_in_place" but attached no body. Re-call with the full rewritten body.';
    }
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
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.children !== undefined
          ? {
              children: args.children.map((c) => ({
                ...c,
                assignee: c.assignee ?? null,
                priority: c.priority ?? null,
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
