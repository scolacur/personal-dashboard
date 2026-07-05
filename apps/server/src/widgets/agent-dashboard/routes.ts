import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_ASSIGNEES,
  type CreateTicketInput,
  type TicketAssignee,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
} from '@dashboard/shared';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import {
  archiveTicket,
  createProject,
  createTicket,
  getProjectBySlug,
  getTicketIssueRef,
  listNotifications,
  listProjects,
  listTickets,
  markAllNotificationsRead,
  markNotificationRead,
  projectExists,
  unreadNotificationCount,
  updateTicket,
} from './store';
import { GITHUB_WRITE_TOKEN_ENV, closeIssueNotPlanned, postIssueComment } from './github-sync';

function isPriority(v: unknown): v is TicketPriority {
  return typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is TicketStatus {
  return typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);
}

function isAssignee(v: unknown): v is TicketAssignee {
  return typeof v === 'string' && (TICKET_ASSIGNEES as readonly string[]).includes(v);
}

/** Injectable deps for the routes — defaults resolve from the environment / global fetch. */
export interface AgentDashboardRouteDeps {
  /** Write-scoped GitHub token for close-on-delete (PD-207 A). Defaults to `GITHUB_WRITE_TOKEN`. */
  githubWriteToken?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  deps: AgentDashboardRouteDeps = {},
): void {
  const base = '/api/widgets/agent-dashboard';

  /* ── Projects ─────────────────────────────── */

  app.get(`${base}/projects`, async () => listProjects(db));

  app.post(`${base}/projects`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.slug !== 'string' || body.slug.trim() === '') {
      return reply.status(400).send({ error: 'slug is required', code: 'INVALID_SLUG' });
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.status(400).send({ error: 'name is required', code: 'INVALID_NAME' });
    }
    if (getProjectBySlug(db, body.slug.trim())) {
      return reply.status(409).send({ error: 'project slug already exists', code: 'DUPLICATE_SLUG' });
    }
    return reply.status(201).send(
      createProject(db, {
        slug: body.slug.trim(),
        name: body.name.trim(),
        githubRepo: typeof body.githubRepo === 'string' ? body.githubRepo : null,
        sortieEnabled: body.sortieEnabled === true,
        color: typeof body.color === 'string' ? body.color : null,
      }),
    );
  });

  /* ── Tickets ────────────────────────────────── */

  app.get(`${base}/tickets`, async () => listTickets(db));

  app.post(`${base}/tickets`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return reply.status(400).send({ error: 'title is required', code: 'INVALID_TITLE' });
    }
    if (typeof body.projectId !== 'number' || !Number.isInteger(body.projectId)) {
      return reply.status(400).send({ error: 'projectId is required', code: 'INVALID_PROJECT' });
    }
    if (!projectExists(db, body.projectId)) {
      return reply.status(400).send({ error: 'unknown projectId', code: 'UNKNOWN_PROJECT' });
    }
    // priority may be null (explicitly unset) or a valid P-level; anything else is invalid.
    if (body.priority !== undefined && body.priority !== null && !isPriority(body.priority)) {
      return reply.status(400).send({ error: 'invalid priority', code: 'INVALID_PRIORITY' });
    }
    if (body.body !== undefined && body.body !== null && typeof body.body !== 'string') {
      return reply.status(400).send({ error: 'body must be a string', code: 'INVALID_BODY' });
    }
    // assignee may be null (unassigned) or a valid value; anything else is invalid.
    if (body.assignee !== undefined && body.assignee !== null && !isAssignee(body.assignee)) {
      return reply.status(400).send({ error: 'invalid assignee', code: 'INVALID_ASSIGNEE' });
    }
    if (body.status !== undefined && !isStatus(body.status)) {
      return reply.status(400).send({ error: 'invalid status', code: 'INVALID_STATUS' });
    }

    const input: CreateTicketInput = {
      title: body.title.trim(),
      projectId: body.projectId,
      body: (body.body as string | null | undefined) ?? null,
      priority: body.priority === null ? null : isPriority(body.priority) ? body.priority : undefined,
      assignee: body.assignee === undefined ? undefined : body.assignee === null ? null : (body.assignee as TicketAssignee),
      status: isStatus(body.status) ? body.status : undefined,
    };
    return reply.status(201).send(createTicket(db, input));
  });

  app.patch(`${base}/tickets/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: UpdateTicketInput = {};

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        return reply.status(400).send({ error: 'invalid title', code: 'INVALID_TITLE' });
      }
      patch.title = body.title.trim();
    }
    if (body.body !== undefined) {
      if (body.body !== null && typeof body.body !== 'string') {
        return reply.status(400).send({ error: 'body must be a string', code: 'INVALID_BODY' });
      }
      patch.body = body.body as string | null;
    }
    if (body.status !== undefined) {
      if (!isStatus(body.status)) {
        return reply.status(400).send({ error: 'invalid status', code: 'INVALID_STATUS' });
      }
      patch.status = body.status;
    }
    if (body.priority !== undefined) {
      // null = unset; otherwise must be a valid P-level.
      if (body.priority !== null && !isPriority(body.priority)) {
        return reply.status(400).send({ error: 'invalid priority', code: 'INVALID_PRIORITY' });
      }
      patch.priority = body.priority as TicketPriority | null;
    }
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'number' || !projectExists(db, body.projectId)) {
        return reply.status(400).send({ error: 'unknown projectId', code: 'UNKNOWN_PROJECT' });
      }
      patch.projectId = body.projectId;
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        return reply
          .status(400)
          .send({ error: 'sortOrder must be a number', code: 'INVALID_SORT_ORDER' });
      }
      patch.sortOrder = body.sortOrder;
    }
    if (body.assignee !== undefined) {
      // null = unassign; otherwise must be a valid value.
      if (body.assignee !== null && !isAssignee(body.assignee)) {
        return reply.status(400).send({ error: 'invalid assignee', code: 'INVALID_ASSIGNEE' });
      }
      patch.assignee = body.assignee as TicketAssignee | null;
    }
    if (body.githubIssueNumber !== undefined) {
      // null = unlink; otherwise a positive integer issue number.
      if (
        body.githubIssueNumber !== null &&
        (typeof body.githubIssueNumber !== 'number' ||
          !Number.isInteger(body.githubIssueNumber) ||
          body.githubIssueNumber <= 0)
      ) {
        return reply
          .status(400)
          .send({ error: 'invalid githubIssueNumber', code: 'INVALID_GITHUB_ISSUE_NUMBER' });
      }
      patch.githubIssueNumber = body.githubIssueNumber as number | null;
    }
    if (body.githubIssueUrl !== undefined) {
      if (body.githubIssueUrl !== null && typeof body.githubIssueUrl !== 'string') {
        return reply
          .status(400)
          .send({ error: 'githubIssueUrl must be a string', code: 'INVALID_GITHUB_ISSUE_URL' });
      }
      patch.githubIssueUrl = body.githubIssueUrl as string | null;
    }

    const updated = updateTicket(db, id, patch);
    if (!updated) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    return updated;
  });

  // Soft-delete: archives the ticket (recoverable), hidden from the board.
  app.delete(`${base}/tickets/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    // Capture the linked-issue ref before archiving (archive keeps it, but read once).
    const ref = getTicketIssueRef(db, id);
    if (!archiveTicket(db, id)) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    // PD-207 A: best-effort close the linked issue as "not planned" so Sortie stops
    // building a ticket that was just archived. Never blocks the 204 — a GitHub failure
    // is logged and swallowed (deletion is ticket-authoritative, D-039).
    const token = deps.githubWriteToken ?? process.env[GITHUB_WRITE_TOKEN_ENV];
    if (ref?.githubIssueNumber != null && ref.githubRepo && token) {
      try {
        const ok = await closeIssueNotPlanned(
          ref.githubRepo,
          ref.githubIssueNumber,
          token,
          deps.fetchImpl ?? fetch,
        );
        if (ok) {
          app.log.info(
            `agent-dashboard: closed ${ref.githubRepo}#${ref.githubIssueNumber} not_planned (ticket ${id} archived)`,
          );
        } else {
          app.log.error(
            `agent-dashboard: close ${ref.githubRepo}#${ref.githubIssueNumber} failed (ticket ${id} archived)`,
          );
        }
      } catch (err) {
        app.log.error(
          `agent-dashboard: close ${ref.githubRepo}#${ref.githubIssueNumber} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return reply.status(204).send();
  });

  /* ── Notifications (Notification Center, D-040) ─────────────── */

  // List notifications, newest first. `?unread=1` limits to unread; `?limit=N` caps the
  // count (the nav dropdown passes limit=10; the full-history page omits it).
  app.get(`${base}/notifications`, async (request) => {
    const q = request.query as { unread?: string; limit?: string };
    const parsed = q.limit != null ? Number(q.limit) : NaN;
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    return listNotifications(db, { unreadOnly: q.unread === '1' || q.unread === 'true', limit });
  });

  // Unread count — cheap poll for the nav bell badge.
  app.get(`${base}/notifications/unread-count`, async () => ({ count: unreadNotificationCount(db) }));

  app.post(`${base}/notifications/:id/read`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!markNotificationRead(db, id)) {
      return reply.status(404).send({ error: 'notification not found', code: 'NOT_FOUND' });
    }
    return reply.status(204).send();
  });

  app.post(`${base}/notifications/read-all`, async () => ({ marked: markAllNotificationsRead(db) }));

  // Inline reply to a parked agent (PD-250). Posts the reply as a GitHub issue comment
  // carrying the human-reply marker, so the sortie-ask-human Action (PD-133) re-queues the
  // agent. Requires the ticket to have a linked issue and a write token to be configured.
  app.post(`${base}/tickets/:id/reply`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.body !== 'string' || body.body.trim() === '') {
      return reply.status(400).send({ error: 'reply body is required', code: 'INVALID_BODY' });
    }
    const ref = getTicketIssueRef(db, id);
    if (!ref) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    if (ref.githubIssueNumber == null || !ref.githubRepo) {
      return reply
        .status(409)
        .send({ error: 'ticket has no linked GitHub issue', code: 'NO_LINKED_ISSUE' });
    }
    const token = deps.githubWriteToken ?? process.env[GITHUB_WRITE_TOKEN_ENV];
    if (!token) {
      return reply
        .status(503)
        .send({ error: 'reply unavailable — no write token configured', code: 'NO_WRITE_TOKEN' });
    }
    const commentBody = `${body.body.trim()}\n\n${HUMAN_REPLY_MARKER}`;
    const ok = await postIssueComment(
      ref.githubRepo,
      ref.githubIssueNumber,
      commentBody,
      token,
      deps.fetchImpl ?? fetch,
    );
    if (!ok) {
      app.log.error(`agent-dashboard: reply to ${ref.githubRepo}#${ref.githubIssueNumber} failed`);
      return reply.status(502).send({ error: 'GitHub rejected the reply', code: 'GITHUB_ERROR' });
    }
    app.log.info(`agent-dashboard: replied to ${ref.githubRepo}#${ref.githubIssueNumber} (ticket ${id})`);
    return reply.status(201).send({ ok: true });
  });
}
