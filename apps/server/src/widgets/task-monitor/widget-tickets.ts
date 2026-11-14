import type Database from 'better-sqlite3';
import type { AgentTicket, TicketEvent, WidgetTicketInput } from '@dashboard/shared';
import { createTicket, getProjectBySlug, getTicket, startRefine } from './store';

/**
 * Widget tickets — the "+" on every widget card (the front door of PD-578, In-widget prompt to
 * ticket to Robot). Whatever Steve types becomes a backlog Ticket that carries the widget it was
 * filed from. Optionally the same request opens a Refine session ("grill me first"), so the ask is
 * interrogated before it is shaped into work.
 *
 * Deliberately *not* PD-580's (In-widget prompt affordance) full flow: no LLM drafting, no approval
 * gate, no queueing. The ticket lands in backlog, unassigned, unrefined — nothing here can cause a
 * Robot run (the dispatch query needs `assignee = 'robot'` and a queue lane).
 */

/** Provenance tag stamped on every widget ticket: `widget:<id>`. */
export const WIDGET_SOURCE_PREFIX = 'widget:';
/** Marks the triage-inbox Epic so it is found again, not recreated. */
export const WIDGET_INBOX_SOURCE = 'widget-inbox';
export const WIDGET_INBOX_TITLE = '[Epic] Widget tickets — triage inbox';

const TITLE_MAX = 90;

const INBOX_BODY = [
  'Holding Epic for tickets filed with the **+** button on a widget card.',
  '',
  'Every Ticket must belong to an Epic (D-080), but a quick widget note should not join the',
  "widget's own Epic: that Epic may be refined and in the Robot's Queue, and a new member would",
  'un-refine and pause it. So widget tickets land here instead. Triage by moving each one to its',
  'real Epic.',
].join('\n');

export type WidgetTicketFailure =
  | { ok: false; code: 'INVALID_TEXT' | 'INVALID_WIDGET' | 'NO_PROJECT'; message: string };

export type WidgetTicketResult =
  | { ok: true; ticket: AgentTicket; refineEvent: TicketEvent | null }
  | WidgetTicketFailure;

/**
 * Title and body for a widget ticket. Pure, so the shape is testable without a DB.
 * The title is the first non-empty line, prefixed with the widget's name in the board's
 * `[Area] …` convention; the full text goes in the body, followed by the provenance footer the
 * Refine agent reads as context.
 */
export function composeWidgetTicket(input: WidgetTicketInput): { title: string; body: string } {
  const text = input.text.trim();
  const firstLine = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? text;
  const prefix = `[${input.widgetTitle}] `;
  const room = TITLE_MAX - prefix.length;
  const head = firstLine.length > room ? `${firstLine.slice(0, room - 1).trimEnd()}…` : firstLine;

  const provenance = [
    '---',
    `_Filed from the **${input.widgetTitle}** widget card (widget id \`${input.widgetId}\`, page ` +
      `\`${input.route}\`) with the + button. The widget is the context this ask is written against._`,
  ].join('\n');

  return { title: prefix + head, body: `${text}\n\n${provenance}` };
}

/** The open triage-inbox Epic for a project, created on first use. */
export function ensureWidgetInboxEpic(db: Database.Database, projectId: number): number {
  const row = db
    .prepare(
      `SELECT id FROM agent_tickets
        WHERE project_id = ? AND source = ? AND is_epic = 1 AND archived_at IS NULL
          AND status NOT IN ('completed', 'closed')
        ORDER BY id LIMIT 1`,
    )
    .get(projectId, WIDGET_INBOX_SOURCE) as { id: number } | undefined;
  if (row) return row.id;
  return createTicket(db, {
    title: WIDGET_INBOX_TITLE,
    body: INBOX_BODY,
    projectId,
    isEpic: true,
    source: WIDGET_INBOX_SOURCE,
  }).id;
}

function validate(raw: Record<string, unknown>): WidgetTicketInput | WidgetTicketFailure {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const text = str(raw.text);
  if (!text) return { ok: false, code: 'INVALID_TEXT', message: 'text is required' };
  const widgetId = str(raw.widgetId);
  const widgetTitle = str(raw.widgetTitle);
  const route = str(raw.route);
  if (!/^[a-z0-9-]+$/.test(widgetId) || !widgetTitle || !route.startsWith('/')) {
    return {
      ok: false,
      code: 'INVALID_WIDGET',
      message: 'widgetId (kebab-case), widgetTitle and route are required',
    };
  }
  return { text, widgetId, widgetTitle, route, refine: raw.refine === true };
}

/** File a widget ticket into the Personal Dashboard backlog; open Refine on it when asked. */
export function fileWidgetTicket(db: Database.Database, raw: Record<string, unknown>): WidgetTicketResult {
  const input = validate(raw);
  if ('ok' in input) return input;

  // Widgets are the dashboard's own surface, so their tickets are always Personal Dashboard work.
  const project = getProjectBySlug(db, 'personal-dashboard');
  if (!project) return { ok: false, code: 'NO_PROJECT', message: 'personal-dashboard project missing' };

  const { title, body } = composeWidgetTicket(input);
  const file = db.transaction(() => {
    const epicId = ensureWidgetInboxEpic(db, project.id);
    return createTicket(db, {
      title,
      body,
      projectId: project.id,
      epicId,
      source: `${WIDGET_SOURCE_PREFIX}${input.widgetId}`,
    });
  });
  const created = file();

  let refineEvent: TicketEvent | null = null;
  if (input.refine) {
    const started = startRefine(db, created.id);
    // A brand-new ticket has no thread, so this only fails if the row vanished mid-request.
    if (started.ok) refineEvent = started.event;
  }
  return { ok: true, ticket: getTicket(db, created.id) ?? created, refineEvent };
}
