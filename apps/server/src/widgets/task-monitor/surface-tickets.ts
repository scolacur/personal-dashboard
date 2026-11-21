import type Database from 'better-sqlite3';
import type {
  AgentTicket,
  SurfaceTicketInput,
  TicketEvent,
  TicketPriority,
  TicketSurface,
} from '@dashboard/shared';
import { TICKET_PRIORITIES } from '@dashboard/shared';
import { createTicket, getProjectBySlug, getTicket, startRefine } from './store';

/**
 * Suggestion tickets — the front door of PD-578 (In-widget prompt to ticket to Robot). Whatever
 * Steve types becomes a backlog Ticket that carries where it was filed from, at one of three
 * scopes:
 *
 * - **widget** — the + floating in a widget card's corner (PD-734);
 * - **page** — the "Suggest a change to this page" footer at the bottom of every page;
 * - **app** — the button in the top nav, for changes broader than any one page.
 *
 * Optionally the same request opens a Refine session ("grill me first"), so the ask is
 * interrogated before it is shaped into work.
 *
 * A priority picked in the dialog (PD-836) is stored on the ticket, so suggestions no longer sink
 * to the bottom of the backlog as unprioritized.
 *
 * Deliberately *not* PD-580's (In-widget prompt affordance) full flow: no LLM drafting, no approval
 * gate, no queueing. The ticket lands in backlog, unassigned, unrefined — nothing here can cause a
 * Robot run (the dispatch query needs `assignee = 'robot'` and a queue lane).
 */

/** Provenance tags stamped on each ticket: `widget:<id>`, `page:<route>`, or `app`. */
export const WIDGET_SOURCE_PREFIX = 'widget:';
export const PAGE_SOURCE_PREFIX = 'page:';
export const APP_SOURCE = 'app';
/** Marks the triage-inbox Epic so it is found again, not recreated. The value predates page and
 *  app scopes; it is kept so the Epic already on the board is still the one found. */
export const WIDGET_INBOX_SOURCE = 'widget-inbox';
export const WIDGET_INBOX_TITLE = '[Epic] Widget tickets — triage inbox';
/** Title prefix for app-scope tickets, matching the board's existing `[Shell]` area. */
export const APP_TITLE_AREA = 'Shell';

const TITLE_MAX = 90;

const INBOX_BODY = [
  'Holding Epic for tickets filed with the **+** on a widget card, the **Suggest a change** footer',
  'at the bottom of a page, or the app-wide **Suggest** button in the top nav.',
  '',
  'Every Ticket must belong to an Epic (D-080), but a quick note should not join the',
  "widget's own Epic: that Epic may be refined and in the Robot's Queue, and a new member would",
  'un-refine and pause it. So these tickets land here instead. Triage by moving each one to its',
  'real Epic.',
].join('\n');

export type SurfaceTicketFailure = {
  ok: false;
  code: 'INVALID_TEXT' | 'INVALID_SURFACE' | 'INVALID_PRIORITY' | 'NO_PROJECT';
  message: string;
};

export type SurfaceTicketResult =
  { ok: true; ticket: AgentTicket; refineEvent: TicketEvent | null } | SurfaceTicketFailure;

function titleArea(surface: TicketSurface): string {
  switch (surface.kind) {
    case 'widget':
      return surface.widgetTitle;
    case 'page':
      return surface.pageTitle;
    case 'app':
      return APP_TITLE_AREA;
  }
}

function provenanceLine(surface: TicketSurface): string {
  switch (surface.kind) {
    case 'widget':
      return (
        `_Filed from the **${surface.widgetTitle}** widget card (widget id \`${surface.widgetId}\`, page ` +
        `\`${surface.route}\`) with the + button. The widget is the context this ask is written against._`
      );
    case 'page':
      return (
        `_Filed from the **${surface.pageTitle}** page (\`${surface.route}\`) with the Suggest-a-change ` +
        `footer. The page as a whole is the context this ask is written against._`
      );
    case 'app':
      return (
        '_Filed with the app-wide Suggest button in the top nav. This ask is about the dashboard as a ' +
        'whole, not any one page or widget._'
      );
  }
}

function sourceTag(surface: TicketSurface): string {
  switch (surface.kind) {
    case 'widget':
      return `${WIDGET_SOURCE_PREFIX}${surface.widgetId}`;
    case 'page':
      return `${PAGE_SOURCE_PREFIX}${surface.route}`;
    case 'app':
      return APP_SOURCE;
  }
}

/**
 * Title and body for a suggestion ticket. Pure, so the shape is testable without a DB.
 * The title is the first non-empty line, prefixed with the surface's name in the board's
 * `[Area] …` convention; the full text goes in the body, followed by the provenance footer the
 * Refine agent reads as context.
 */
export function composeSurfaceTicket(input: SurfaceTicketInput): { title: string; body: string } {
  const text = input.text.trim();
  const firstLine =
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? text;
  const prefix = `[${titleArea(input.surface)}] `;
  const room = TITLE_MAX - prefix.length;
  const head = firstLine.length > room ? `${firstLine.slice(0, room - 1).trimEnd()}…` : firstLine;

  const provenance = ['---', provenanceLine(input.surface)].join('\n');
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

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const invalidSurface = (message: string): SurfaceTicketFailure => ({
  ok: false,
  code: 'INVALID_SURFACE',
  message,
});

function validateSurface(raw: unknown): TicketSurface | SurfaceTicketFailure {
  if (typeof raw !== 'object' || raw === null) return invalidSurface('surface is required');
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case 'widget': {
      const widgetId = str(s.widgetId);
      const widgetTitle = str(s.widgetTitle);
      const route = str(s.route);
      if (!/^[a-z0-9-]+$/.test(widgetId) || !widgetTitle || !route.startsWith('/')) {
        return invalidSurface('widget surface needs widgetId (kebab-case), widgetTitle and route');
      }
      return { kind: 'widget', widgetId, widgetTitle, route };
    }
    case 'page': {
      const pageTitle = str(s.pageTitle);
      const route = str(s.route);
      if (!pageTitle || !route.startsWith('/')) {
        return invalidSurface('page surface needs pageTitle and a route starting with /');
      }
      return { kind: 'page', pageTitle, route };
    }
    case 'app':
      return { kind: 'app' };
    default:
      return invalidSurface("surface.kind must be 'widget', 'page' or 'app'");
  }
}

function validate(raw: Record<string, unknown>): SurfaceTicketInput | SurfaceTicketFailure {
  const text = str(raw.text);
  if (!text) return { ok: false, code: 'INVALID_TEXT', message: 'text is required' };
  const surface = validateSurface(raw.surface);
  if ('ok' in surface) return surface;
  // PD-836: optional, but a value that is present must be a real level — never silently dropped.
  let priority: TicketPriority | null = null;
  if (raw.priority !== undefined && raw.priority !== null) {
    if (!TICKET_PRIORITIES.includes(raw.priority as TicketPriority)) {
      return { ok: false, code: 'INVALID_PRIORITY', message: 'priority must be one of P0–P5' };
    }
    priority = raw.priority as TicketPriority;
  }
  return { text, surface, refine: raw.refine === true, priority };
}

/**
 * The pre-scope request shape (PD-734): `{ text, widgetId, widgetTitle, route, refine }`. Kept
 * on the old `/widget-tickets` route so a tab loaded before this deploy still files.
 */
export function fromLegacyWidgetBody(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    text: raw.text,
    refine: raw.refine,
    surface: {
      kind: 'widget',
      widgetId: raw.widgetId,
      widgetTitle: raw.widgetTitle,
      route: raw.route,
    },
  };
}

/** File a suggestion ticket into the Personal Dashboard backlog; open Refine on it when asked. */
export function fileSurfaceTicket(
  db: Database.Database,
  raw: Record<string, unknown>,
): SurfaceTicketResult {
  const input = validate(raw);
  if ('ok' in input) return input;

  // Every surface is the dashboard's own, so these tickets are always Personal Dashboard work.
  const project = getProjectBySlug(db, 'personal-dashboard');
  if (!project)
    return { ok: false, code: 'NO_PROJECT', message: 'personal-dashboard project missing' };

  const { title, body } = composeSurfaceTicket(input);
  const file = db.transaction(() => {
    const epicId = ensureWidgetInboxEpic(db, project.id);
    return createTicket(db, {
      title,
      body,
      projectId: project.id,
      epicId,
      priority: input.priority ?? null,
      source: sourceTag(input.surface),
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
