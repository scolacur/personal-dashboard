import { z } from 'zod';
import {
  ROBOT_MAX_TURNS_DEFAULT,
  ROBOT_MAX_TURNS_LIMIT,
  REFINE_TURN_ESTIMATE_FLOOR,
  CODER_AREA_IDS,
  coerceTicketStatus,
  refineRelationsError,
  refineSupersedesError,
} from '@dashboard/shared';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CoderArea, RefineProposal, RefineQuestionRound } from '@dashboard/shared';
import type Database from 'better-sqlite3';
import { buildAskQuestionsTool } from './ask-tool';
import { buildBoardTools, read } from './board-tools';

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

// PD-896: what kind of work the ticket is. Feeds the Velocity bug-rate metrics (PD-881).
const KIND = z.enum(['bug', 'feature', 'chore']).nullable();

// PD-880: the Coder code-area subtype, validated against the shared registry. An invalid area is a
// self-correcting tool error here (at propose time), before the proposal is ever recorded. Driven
// off `CODER_AREA_IDS` so the enum can never drift from the registry the server validates against.
const CODER_AREA = z.enum(CODER_AREA_IDS as unknown as [CoderArea, ...CoderArea[]]).nullable();

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
  kind: KIND.optional(),
  // PD-880: a child's area override. Omit to inherit the Epic's area; set only when the child differs.
  coderArea: CODER_AREA.optional(),
  // PD-634: born refined unless the agent says otherwise. The server still downgrades a robot child
  // whose body is not Ready-shaped, so this can only ever claim less than the mechanical check.
  refined: z.boolean().optional(),
});

// PD-842: a relation between two children, by 0-based index into `children` (they have no ids
// until approval creates them). Only `blocks` / `relates` — `split` lineage stays automatic.
const RELATION = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  type: z.enum(['blocks', 'relates']),
});

// Raw Zod shape (not z.object) — the SDK's tool() wants the shape.
const PROPOSE_COMMIT_SHAPE = {
  mode: z.enum(['refine_in_place', 'decompose']),
  body: z.string().optional(),
  status: STATUS.optional(),
  assignee: ASSIGNEE.optional(),
  maxTurns: MAX_TURNS.optional(),
  kind: KIND.optional(),
  // PD-880: on refine_in_place THIS ticket's area; on a Populate (decompose of an Epic) the Epic's
  // default area its members inherit.
  coderArea: CODER_AREA.optional(),
  children: z.array(CHILD).optional(),
  relations: z.array(RELATION).optional(),
  // PD-931: existing members this decompose/Populate replaces, by display id. Validated here and
  // re-validated on approval; the close/invalidate of the named members is a sibling slice.
  supersedes: z.array(z.string()).optional(),
  rationale: z.string().optional(),
};

const DESCRIPTION = [
  'Propose the commit for this Refine session once you and Steve have converged. Do NOT call',
  'until the plan is concrete. You never write tickets — this records a proposal Steve approves.',
  'mode "refine_in_place": provide the rewritten `body` (+ optional `assignee`)',
  'for THIS ticket. mode "decompose": provide `children` (each title/body/status/assignee);',
  'the parent is then closed and linked to them — EXCEPT when the parent is an Epic, where the same',
  'decompose is reinterpreted as Populate (D-058): children become members of the Epic and the Epic',
  'stays open (no close, no split). A Populate MUST also carry the Epic\'s rewritten `body`: the',
  'description that frames the members you are proposing. Approving it marks the Epic refined.',
  'Children are born refined — set `refined: false` on a child ONLY if it is a placeholder that needs',
  'its own Refine session. The standard: a child is refined if you would hand it to a Robot as-is.',
  'A robot-assigned child without the four sections lands unrefined whatever you claim.',
  'OPTIONAL `relations` (decompose only): edges between the children you propose, each',
  '{ from, to, type } with `from`/`to` as 0-based indexes into `children` and type "blocks" (from must',
  'finish before to can start) or "relates". When the slices form a dependency chain, PUT IT HERE —',
  'they are written on approval alongside the children. Never ask Steve to wire links by hand.',
  'OPTIONAL `supersedes` (decompose/Populate only): display ids of EXISTING tickets this proposal',
  'replaces — each MUST be an OPEN member of the Epic you are populating (check with',
  'list_epic_members first). Use it when a child you are proposing takes over work an existing member',
  'already owns, so that approval can later retire that member instead of leaving a duplicate. Do NOT',
  'put it on refine_in_place, do not repeat an id, and do not name a ticket that is done, archived, or',
  'under a different Epic — each is refused with a message telling you how to fix it.',
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
  `\`maxTurns\` (PD-432, D-110): estimate the ticket's turn ceiling in BOTH directions — a LOW ceiling`,
  `for a small ticket (not only a raised one for irreducible work). Set it on ~every ticket; the`,
  `default when omitted is ${ROBOT_MAX_TURNS_DEFAULT}, which is a 5x licence to spin on a small ticket. Anchor on the`,
  `scale in the system prompt (~25 small / ~40 one subsystem / default for a vertical slice), never below the`,
  `floor of ${REFINE_TURN_ESTIMATE_FLOOR}, rounding up for headroom. A RAISED ceiling (above ${ROBOT_MAX_TURNS_DEFAULT}) still requires the`,
  `"cannot decompose further" argument in \`rationale\`; a lowered one does not. Omit only when you`,
  `genuinely cannot gauge the size.`,
  'SET `kind` (PD-896) — "bug" (something that worked, or should have, is broken), "feature" (new',
  'capability or a change to how something works) or "chore" (maintenance, docs, infra, cleanup with no',
  'user-visible change) — on THIS ticket (refine_in_place) and on each child. A child without `kind`',
  "inherits the parent's. The bug-rate metrics count `kind: \"bug\"`, so classify by what the work IS,",
  'not by how the ticket was titled; null only when it genuinely fits none.',
  'ALWAYS SET `coderArea` (PD-880) — the Coder code-area subtype — choosing from the paths the body',
  'names: "board" (Task Monitor, detail pages), "planning" (Refine, Decisions inbox, auto-queue),',
  '"loop" (worker, dispatch, Evaluator, merge pipeline), "metrics" (Velocity, Agent Dashboard),',
  '"widgets" (widgets), "infra" (Docker, CI, deploy), "shell" (nav, layout, pages), or "general"',
  'when it spans several. On refine_in_place set it on THIS ticket; on a Populate set the Epic\'s',
  'default on the parent and set a child\'s `coderArea` ONLY when that child\'s area differs from the',
  "Epic's (an unset child inherits the Epic). Do not ask Steve — infer it from the files the work touches.",
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

/**
 * PD-931: the board half of `supersedes` validation — resolve each display id against the live
 * board and reject any that is missing/archived, not open, or not a member of the Epic being
 * populated. The caller has already run the mechanical `refineSupersedesError`, so every id here is
 * well-formed and unique. Returns an instructive error (so the agent re-proposes), or null.
 *
 * The Epic whose members may be superseded is the target itself when it is an Epic (Populate);
 * otherwise a plain decompose keeps its children under the target's own Epic, so that is the Epic.
 * With no Epic in either case there is nothing a member could be superseded from.
 */
function supersedesBoardError(
  board: Database.Database,
  supersedes: readonly string[],
  opts: { targetIsEpic?: boolean; targetTicketId?: number },
): string | null {
  let epicId: number | null = null;
  if (opts.targetIsEpic) {
    epicId = opts.targetTicketId ?? null;
  } else if (opts.targetTicketId !== undefined) {
    const row = read(board, 'SELECT epic_id FROM agent_tickets WHERE id = ? AND archived_at IS NULL').get(
      opts.targetTicketId,
    ) as { epic_id: number | null } | undefined;
    epicId = row?.epic_id ?? null;
  }
  if (epicId === null) {
    return '`supersedes` may only name members of the Epic being populated, but this decompose is not under an Epic — there is no Epic whose members it could replace. Drop `supersedes`.';
  }
  for (const raw of supersedes) {
    const row = read(
      board,
      'SELECT status, epic_id FROM agent_tickets WHERE display_id = ? AND archived_at IS NULL',
    ).get(raw.toUpperCase()) as { status: string; epic_id: number | null } | undefined;
    if (!row) {
      return `\`supersedes\` names "${raw}", but no such open ticket is on the board (wrong id, or it is archived). Only an existing OPEN member of the target Epic may be superseded — remove it or fix the id.`;
    }
    if (row.status === 'completed' || row.status === 'closed') {
      return `\`supersedes\` names "${raw}", but it is already ${row.status} — a terminal ticket needs no replacing, only an OPEN member can be superseded. Remove it from \`supersedes\`.`;
    }
    if (row.epic_id !== epicId) {
      return `\`supersedes\` names "${raw}", but it is not a member of the Epic being populated — you may only supersede members of the target Epic (PD-931). Move it under the Epic first, or drop it from \`supersedes\`.`;
    }
  }
  return null;
}

/** The mode↔fields shape that Zod (optional-everything) can't express. Zod makes `children`
 *  and `body` unconditionally optional regardless of `mode`, so a `decompose` with no children
 *  (or a `refine_in_place` with no body) passes tool validation and is only caught much later at
 *  approval time — surfacing to Steve as a confusing "invalid proposal" instead of to the agent
 *  as an immediate, self-correcting tool error. Enforce the invariant here at the call boundary.
 *  Returns an instructive error string, or null when the proposal is well-formed. */
export function validateProposalShape(
  proposal: RefineProposal,
  opts: { targetIsEpic?: boolean; targetTicketId?: number; board?: Database.Database } = {},
): string | null {
  // PD-931: the board-free shape rule (wrong mode / malformed id / duplicate) first, so the agent
  // gets the cheap error before any id resolution. When the worker handed over its DB handle the
  // id-resolution rule (exists / open / member of the target Epic) runs on top.
  const supersedesErr = refineSupersedesError(proposal.supersedes, proposal.mode);
  if (supersedesErr) return supersedesErr;
  if (opts.board && proposal.supersedes && proposal.supersedes.length > 0) {
    const boardErr = supersedesBoardError(opts.board, proposal.supersedes, opts);
    if (boardErr) return boardErr;
  }
  if (proposal.mode === 'decompose') {
    if (!proposal.children || proposal.children.length === 0) {
      return 'decompose requires a non-empty `children` array — you set mode "decompose" but attached no children. Re-call with each child ticket (title/body/status/assignee).';
    }
    // PD-634: approving a Populate marks the Epic refined, which asserts its description frames the
    // members. That claim is only honest if the description was rewritten for them, in the same panel.
    if (opts.targetIsEpic && (proposal.body === undefined || proposal.body.trim() === '')) {
      return 'this ticket is an Epic, so decompose is a Populate — and a Populate requires the Epic\'s rewritten `body` (its description, framing the members you are proposing). Approving marks the Epic refined on the strength of that description, so it cannot be left as it was. Re-call with `body` set to the full rewritten Epic description.';
    }
    for (const c of proposal.children) {
      const err = queueLaneError(`child "${c.title}"`, c.status);
      if (err) return err;
    }
    // PD-842: relations address children by index, so they are checked against this proposal.
    const relErr = refineRelationsError(proposal.relations, proposal.children.length);
    if (relErr) return `${relErr} Re-call with corrected \`relations\`.`;
  } else if (proposal.mode === 'refine_in_place') {
    if (proposal.relations && proposal.relations.length > 0) {
      return '`relations` link decompose children to each other, but this is refine_in_place — there are no children. Drop `relations`, or decompose if the work really is several tickets.';
    }
    if (proposal.body === undefined) {
      return 'refine_in_place requires the rewritten `body` for this ticket — you set mode "refine_in_place" but attached no body. Re-call with the full rewritten body.';
    }
    const err = queueLaneError('`status`', proposal.status);
    if (err) return err;
  }
  return null;
}

/**
 * Build the in-process `refine` MCP server: `propose_commit`, plus `ask_questions` (PD-744) when
 * `opts.onRound` is given. `onProposal` runs synchronously in the agent-worker when the agent calls
 * propose_commit (it persists the proposal to the shared DB); `onRound` stages a question round.
 */
export function buildProposeToolServer(
  onProposal: (proposal: RefineProposal) => void,
  opts: {
    targetIsEpic?: boolean;
    /** PD-931: the row id of the ticket being refined, so the board half of `supersedes` validation
     *  can resolve the Epic whose members may be superseded. Omitted ⇒ that half is skipped. */
    targetTicketId?: number;
    onRound?: (round: RefineQuestionRound) => void;
    board?: Database.Database;
  } = {},
) {
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
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.coderArea !== undefined ? { coderArea: args.coderArea } : {}),
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
        ...(args.relations !== undefined && args.relations.length > 0
          ? { relations: args.relations }
          : {}),
        ...(args.supersedes !== undefined && args.supersedes.length > 0
          ? { supersedes: args.supersedes }
          : {}),
        ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
      };
      const invalid = validateProposalShape(proposal, opts);
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

  const tools = [
    proposeCommit,
    ...(opts.onRound ? [buildAskQuestionsTool(opts.onRound)] : []),
    // PD-433: read-only board tools, when the worker hands over its DB handle.
    ...(opts.board ? buildBoardTools(opts.board) : []),
  ];
  return createSdkMcpServer({ name: 'refine', version: '0.0.1', tools });
}
