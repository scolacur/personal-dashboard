import { z } from 'zod';
import type Database from 'better-sqlite3';
import { tool } from '@anthropic-ai/claude-agent-sdk';

/**
 * Read-only board tools for the Refine agent (PD-433).
 *
 * Refine was board-blind: it could read the checkout but not `agent_tickets`, so it could not check
 * for an existing ticket before proposing one, name real ids in relations, see an Epic's members, or
 * cite a ticket's history. These tools give it a typed, parameterised view of the board through the
 * same in-process MCP server as `propose_commit`. No Bash, no SQL from the model.
 *
 * **Read-only by construction.** Every statement is checked to be a reader (`stmt.reader`, which
 * better-sqlite3 sets only for statements that return rows) before it runs, so a future edit that
 * slips a write in here throws instead of writing. Approval stays the only write path (D-057).
 *
 * **Context is the risk.** The board has hundreds of tickets, so results are a compact projection,
 * hard-capped server-side, and bodies come only from `get_ticket`, truncated.
 */

export const BOARD_TOOL_NAMES = [
  'mcp__refine__search_tickets',
  'mcp__refine__get_ticket',
  'mcp__refine__list_relations',
  'mcp__refine__list_epic_members',
] as const;

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 25;
export const MEMBERS_LIMIT_MAX = 60;
export const BODY_CHARS_MAX = 6000;

/** The compact row every list returns. */
export interface TicketSummary {
  displayId: string | null;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  isEpic: boolean;
  refined: boolean;
  epic: string | null;
}

interface Row {
  id: number;
  display_id: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  is_epic: number;
  refined: number;
  epic_display_id: string | null;
  epic_title?: string | null;
}

export function read(db: Database.Database, sql: string) {
  const stmt = db.prepare(sql);
  if (!stmt.reader) throw new Error('board tools are read-only');
  return stmt;
}

const SELECT = `
  SELECT t.id, t.display_id, t.title, t.body, t.status, t.priority, t.assignee, t.is_epic, t.refined,
         e.display_id AS epic_display_id, e.title AS epic_title
    FROM agent_tickets t
    LEFT JOIN agent_tickets e ON e.id = t.epic_id`;

const summary = (r: Row): TicketSummary => ({
  displayId: r.display_id,
  title: r.title,
  status: r.status,
  priority: r.priority,
  assignee: r.assignee,
  isEpic: r.is_epic === 1,
  refined: r.refined === 1,
  epic: r.epic_display_id,
});

const clampLimit = (n: number | undefined, max: number, dflt: number) =>
  Math.max(1, Math.min(max, Math.floor(n ?? dflt)));

/**
 * Tickets whose title or body contains EVERY word of `query` (case-insensitive), title matches first.
 * Closed/completed are excluded unless `includeDone`. Archived tickets never appear.
 */
export function searchTickets(
  db: Database.Database,
  args: { query: string; status?: string; epic?: string; includeDone?: boolean; limit?: number },
): { results: TicketSummary[]; truncated: boolean } {
  const words = args.query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 6);
  const limit = clampLimit(args.limit, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const where: string[] = ['t.archived_at IS NULL'];
  const params: (string | number)[] = [];
  for (const w of words) {
    // `\` escapes LIKE's wildcards so a literal % or _ in the query matches itself.
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.display_id = ?)`);
    const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, w.toUpperCase());
  }
  if (args.status) {
    where.push('t.status = ?');
    params.push(args.status);
  } else if (!args.includeDone) {
    where.push("t.status NOT IN ('completed', 'closed')");
  }
  if (args.epic) {
    where.push('e.display_id = ?');
    params.push(args.epic.toUpperCase());
  }
  const titleHit = words.length
    ? `(${words.map(() => `t.title LIKE ? ESCAPE '\\'`).join(' AND ')})`
    : '0';
  const titleParams = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const rows = read(
    db,
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${titleHit} DESC, t.id DESC LIMIT ?`,
  ).all(...params, ...titleParams, limit + 1) as Row[];
  return { results: rows.slice(0, limit).map(summary), truncated: rows.length > limit };
}

/** One ticket with its body (truncated), its Epic, and its relation count. Null when not found. */
export function getTicket(
  db: Database.Database,
  displayId: string,
): (TicketSummary & { body: string; bodyTruncated: boolean; epicTitle: string | null; relations: number }) | null {
  const r = read(db, `${SELECT} WHERE t.display_id = ? AND t.archived_at IS NULL`).get(displayId.toUpperCase()) as
    | Row
    | undefined;
  if (!r) return null;
  const body = r.body ?? '';
  const rel = read(
    db,
    'SELECT COUNT(*) AS n FROM agent_ticket_relations WHERE from_ticket_id = ? OR to_ticket_id = ?',
  ).get(r.id, r.id) as { n: number };
  return {
    ...summary(r),
    body: body.slice(0, BODY_CHARS_MAX),
    bodyTruncated: body.length > BODY_CHARS_MAX,
    epicTitle: r.epic_title ?? null,
    relations: rel.n,
  };
}

export interface RelationEdge {
  type: string;
  /** `outgoing`: this ticket → other (e.g. this blocks other). `incoming`: other → this. */
  direction: 'outgoing' | 'incoming';
  other: TicketSummary;
}

/** Every relation edge touching a ticket, in both directions. Null when the ticket is not found. */
export function listRelations(db: Database.Database, displayId: string): RelationEdge[] | null {
  const t = read(db, 'SELECT id FROM agent_tickets WHERE display_id = ? AND archived_at IS NULL').get(
    displayId.toUpperCase(),
  ) as { id: number } | undefined;
  if (!t) return null;
  const rows = read(
    db,
    `SELECT r.type, CASE WHEN r.from_ticket_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
            CASE WHEN r.from_ticket_id = ? THEN r.to_ticket_id ELSE r.from_ticket_id END AS other_id
       FROM agent_ticket_relations r
      WHERE r.from_ticket_id = ? OR r.to_ticket_id = ?
      ORDER BY r.type, other_id
      LIMIT 100`,
  ).all(t.id, t.id, t.id, t.id) as { type: string; direction: 'outgoing' | 'incoming'; other_id: number }[];
  const byId = read(db, `${SELECT} WHERE t.id = ?`);
  return rows.flatMap((r) => {
    const o = byId.get(r.other_id) as Row | undefined;
    return o ? [{ type: r.type, direction: r.direction, other: summary(o) }] : [];
  });
}

/** An Epic's members (open first), capped. Null when the Epic is not found or is not an Epic. */
export function listEpicMembers(
  db: Database.Database,
  displayId: string,
): { epic: TicketSummary; members: TicketSummary[]; truncated: boolean } | null {
  const e = read(db, `${SELECT} WHERE t.display_id = ? AND t.archived_at IS NULL`).get(displayId.toUpperCase()) as
    | Row
    | undefined;
  if (!e || e.is_epic !== 1) return null;
  const rows = read(
    db,
    `${SELECT} WHERE t.epic_id = ? AND t.archived_at IS NULL
      ORDER BY CASE WHEN t.status IN ('completed', 'closed') THEN 1 ELSE 0 END, t.sort_order, t.id
      LIMIT ?`,
  ).all(e.id, MEMBERS_LIMIT_MAX + 1) as Row[];
  return { epic: summary(e), members: rows.slice(0, MEMBERS_LIMIT_MAX).map(summary), truncated: rows.length > MEMBERS_LIMIT_MAX };
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const notFound = (id: string) => ({
  content: [{ type: 'text' as const, text: `No ticket ${id} on the board (or it is archived). Search instead.` }],
  isError: true,
});
const ID = z.string().regex(/^[A-Za-z]+-\d+$/, 'a display id like PD-433');

/** The four tools, bound to a DB handle. Added to the `refine` MCP server beside propose_commit. */
export function buildBoardTools(db: Database.Database) {
  return [
    tool(
      'search_tickets',
      [
        'Search the live board (read-only). Returns a COMPACT list (id, title, status, priority,',
        `assignee, Epic), at most ${SEARCH_LIMIT_MAX}, never bodies. Every word must appear in the title`,
        'or body. Search NARROWLY with 1-3 distinctive words; never try to enumerate the board.',
        'Use it BEFORE proposing a new ticket, to find an existing one that already covers the work.',
        'Completed/closed tickets are excluded unless includeDone is true.',
      ].join(' '),
      {
        query: z.string().min(1),
        status: z.enum(['backlog', 'queue', 'completed', 'closed']).optional(),
        epic: ID.optional(),
        includeDone: z.boolean().optional(),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
      },
      async (args) => json(searchTickets(db, args)),
    ),
    tool(
      'get_ticket',
      `Read one ticket from the live board, including its body (truncated at ${BODY_CHARS_MAX} chars), its Epic and how many relations it has. Use it when a search result needs detail, or to cite a ticket accurately.`,
      { displayId: ID },
      async ({ displayId }) => {
        const t = getTicket(db, displayId);
        return t ? json(t) : notFound(displayId);
      },
    ),
    tool(
      'list_relations',
      'List the blocks/relates edges touching a ticket, both directions, with each other ticket compact. Use it to propose relations consistent with the ones that exist.',
      { displayId: ID },
      async ({ displayId }) => {
        const r = listRelations(db, displayId);
        return r ? json(r) : notFound(displayId);
      },
    ),
    tool(
      'list_epic_members',
      `List an Epic's member tickets, compact, open first (at most ${MEMBERS_LIMIT_MAX}). Use it to see the siblings before populating or splitting under an Epic.`,
      { displayId: ID },
      async ({ displayId }) => {
        const r = listEpicMembers(db, displayId);
        return r ? json(r) : notFound(`${displayId} as an Epic`);
      },
    ),
  ];
}
