import { z } from 'zod';
import type Database from 'better-sqlite3';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../shared/logger';
import { allocateDecisionId } from './decision-ids-db';

/**
 * `mcp__decisions__allocate` — how a Robot gets a real `D-NNN` (PD-564, part of PD-556).
 *
 * **The agent does not touch the database; the worker allocates for it.** Same division as
 * `mcp__docs__fetch`: the agent supplies an intent, the worker performs the privileged act. That is
 * not a convenience here — it is the whole design, recorded in `D-TMP-PD558a`. The coding uid
 * cannot read `dashboard.db` at all ([[D-055]]'s privilege split, mode-600), and this tool does not
 * relax that. It runs in the worker process, which already holds the handle.
 *
 * ## Why a tool and not the HTTP endpoint
 *
 * PD-557 exposes `POST /api/decisions/allocate`, and a Robot cannot reach it. The agent-worker
 * container sits on `egress_internal` (`internal: true` — no route off the box) and its only exit is
 * the squid sidecar, which permits `CONNECT` to port 443 against a *domain* allowlist. The dashboard
 * is `http://192.168.68.50:8088`: wrong port, plain HTTP, and a bare LAN IP matching no `dstdomain`.
 * Three independent reasons it fails.
 *
 * Opening any of those would have moved a security boundary to solve a problem that an in-process
 * tool solves without moving one. The endpoint keeps serving human authors; both paths increment the
 * same counter with the same single atomic statement.
 *
 * ## Allocation is per decision, at the moment of writing
 *
 * The agent calls this once per decision it records — a run that recognises three decisions makes
 * three calls. Deliberately not one id injected per dispatch: that either wastes an id on every run
 * that decides nothing, or runs out mid-run on the one that decides three things. PD-556 rejected
 * pre-allocation for exactly this reason.
 *
 * An id taken for a decision that is never written leaves a gap in the sequence. Gaps are harmless —
 * `D-086` is an identifier, not a count.
 */

/** Fully-qualified name the SDK exposes (server key `decisions` + tool name). MCP tools are
 *  registered via `mcpServers` and are not "built-in", so this does NOT go in `ROBOT_TOOLS` —
 *  D-068's list is unchanged by this ticket, exactly as PD-310 left it unchanged. */
export const DECISION_ALLOCATE_TOOL_NAME = 'mcp__decisions__allocate';

const DESCRIPTION = [
  'Reserve a real decision id (D-NNN) for a decision you are about to write.',
  'Call this ONCE PER DECISION, at the moment you write the file — not at the start of the run, and',
  'not in advance for decisions you might record later.',
  'The id is yours permanently the instant it is returned: write `DECISIONS/D-NNN-slug.md` with',
  '`# D-NNN: Title` as its first line, and cite `D-NNN` in code and in your PR immediately.',
  'NEVER pick a number yourself and never reuse one — the counter is the only allocator, which is',
  'what stops two authors claiming the same number.',
  'If you end up not writing the decision, just leave the id unused; a gap costs nothing and is far',
  'cheaper than a reused id.',
].join(' ');

const ALLOCATE_SHAPE = {
  title: z
    .string()
    .min(1)
    .optional()
    .describe('The decision title, if you have it. Recorded in the worker log so an allocated id can be traced to what took it.'),
};

/**
 * What the agent is told when the counter is not there.
 *
 * Written to route to the existing ask_human park rather than to a retry loop or a silently
 * hand-picked number — the two failure modes a bare "unavailable" reliably produces here, and the
 * second is the one this whole epic exists to prevent.
 */
export const COUNTER_UNAVAILABLE_GUIDANCE = [
  'REFUSED: the decision-id counter is not available, so no id was allocated.',
  '',
  'Do NOT retry — this will not resolve within your session.',
  'Do NOT pick a number yourself. A hand-picked D-NNN is exactly the collision the counter exists',
  'to prevent, and it has gone wrong here before (D-056, D-065).',
  'Finish the rest of the ticket normally. For the decision itself, park for a human: write',
  '`.robot/ask-human` with the decision title and its reasoning, and a human will allocate and file',
  'it. That is not a fault and it does not count against the ticket.',
].join('\n');

/** What the SDK's `tool()` handler must return. The index signature is what the SDK's own result
 *  type requires — without it this shape is not assignable to the handler's return type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * The tool's whole behaviour, as a plain function.
 *
 * Exported and tested directly rather than through the MCP server: `createSdkMcpServer` folds its
 * tools into an opaque `instance`, so a test that went through it would be reaching into SDK
 * internals to find the handler it wanted to call. Same reason `docs-tool.spec.ts` tests `fetchDoc`
 * rather than the server around it.
 */
export function allocateForAgent(db: Database.Database, ticketId: number, title?: string): ToolResult {
  const id = allocateDecisionId(db);

  if (id === null) {
    logger.error({ ticketId }, 'robot: decision id REFUSED — counter table missing');
    return { content: [{ type: 'text', text: COUNTER_UNAVAILABLE_GUIDANCE }], isError: true };
  }

  // Logged at info with the title so an id in the log can be traced to what took it — including
  // the ids that leave gaps because their decision was never written.
  logger.info({ ticketId, decisionId: id, title: title ?? null }, 'robot: decision id allocated');

  return {
    content: [
      {
        type: 'text',
        text: [
          `Allocated ${id}.`,
          '',
          `Write it to \`DECISIONS/${id}-<slug>.md\` with \`# ${id}: <Title>\` as the first line,`,
          `and cite \`${id}\` directly in code and in your PR. Do not write a provisional id.`,
          'If you record another decision in this run, call this tool again for a separate id.',
        ].join('\n'),
      },
    ],
  };
}

/**
 * Build the in-process MCP server exposing `decisions__allocate`. Registered on the robot session
 * via `mcpServers`, which is orthogonal to the `tools` option — see
 * {@link DECISION_ALLOCATE_TOOL_NAME}.
 *
 * Takes the worker's `db` handle directly: allocation is a write to a shared table, and the point
 * of the tool is that this handle never leaves the worker process.
 */
export function buildDecisionToolServer(db: Database.Database, ticketId: number) {
  const allocateTool = tool('allocate', DESCRIPTION, ALLOCATE_SHAPE, async (args) =>
    allocateForAgent(db, ticketId, args.title),
  );

  return createSdkMcpServer({ name: 'decisions', version: '0.0.1', tools: [allocateTool] });
}
