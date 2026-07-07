import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { RefineProposal } from '@dashboard/shared';

/**
 * The `propose_commit` SDK tool (D-044, PD-269). The agent-worker NEVER writes tickets — when a
 * grill has converged it calls this tool with a structured plan, which hands the proposal to
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

const CHILD = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  status: STATUS,
  assignee: ASSIGNEE.optional(),
});

// Raw Zod shape (not z.object) — the SDK's tool() wants the shape.
const PROPOSE_COMMIT_SHAPE = {
  mode: z.enum(['refine_in_place', 'decompose']),
  body: z.string().optional(),
  status: STATUS.optional(),
  assignee: ASSIGNEE.optional(),
  children: z.array(CHILD).optional(),
  rationale: z.string().optional(),
};

const DESCRIPTION = [
  'Propose the commit for this Refine session once you and Steve have converged. Do NOT call',
  'until the plan is concrete. You never write tickets — this records a proposal Steve approves.',
  'mode "refine_in_place": provide the rewritten `body` (+ optional `status`/`assignee`) for THIS',
  'ticket. mode "decompose": provide `children` (each title/body/status/assignee); the parent is',
  'then closed and linked to them. Any target routed to `robot_queue` MUST have a body with the',
  'four sections: ## Context, ## Task, ## Done When, ## Out of scope.',
].join(' ');

/** The fully-qualified tool name the SDK exposes (server key `refine` + tool name). */
export const PROPOSE_TOOL_NAME = 'mcp__refine__propose_commit';

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
        ...(args.children !== undefined
          ? { children: args.children.map((c) => ({ ...c, assignee: c.assignee ?? null })) }
          : {}),
        ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
      };
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
