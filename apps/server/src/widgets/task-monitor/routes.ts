import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_ASSIGNEES,
  RELATION_TYPES,
  type CreateTicketInput,
  type RelationType,
  type TicketAssignee,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
} from '@dashboard/shared';
import { HUMAN_REPLY_MARKER } from '@dashboard/shared';
import {
  addRelation,
  appendRefineReply,
  appendRobotReply,
  approveRefine,
  type ApproveRefineResult,
  archiveTicket,
  computeEpicSummary,
  EpicGuardError,
  listEpicMembers,
  listEpicSummaries,
  createProject,
  createTicket,
  getDispatchPauseState,
  getProjectBySlug,
  getSortieFleet,
  getTicket,
  getTicketIssueRef,
  listAllRelations,
  listNotifications,
  listProjects,
  listRelations,
  listTicketEvents,
  listTickets,
  listWorkerHeartbeats,
  markAllNotificationsRead,
  markNotificationRead,
  projectExists,
  QueueBlockedError,
  rejectRefine,
  RelationCycleError,
  removeRelationById,
  resetRobotRuns,
  SelfRelationError,
  setDispatchPaused,
  startRefine,
  unreadNotificationCount,
  updateTicket,
} from './store';
import { getRun, insertRequestedRunIfNone, listFindings, listRuns } from './audit-store';
import { listRunsForTicket } from './runs-store';
import {
  GITHUB_WRITE_TOKEN_ENV,
  closeIssueNotPlanned,
  postIssueComment,
} from './github-sync';

function isPriority(v: unknown): v is TicketPriority {
  return typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is TicketStatus {
  return typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);
}

function isAssignee(v: unknown): v is TicketAssignee {
  return typeof v === 'string' && (TICKET_ASSIGNEES as readonly string[]).includes(v);
}

/** Map an Epic invariant violation (D-054) to an HTTP reply. */
const EPIC_ERROR_STATUS: Record<EpicGuardError['code'], number> = {
  NESTING: 400,
  NOT_AN_EPIC: 400,
  CROSS_PROJECT: 400,
  EPIC_NOT_FOUND: 404,
  EPIC_NOT_QUEUEABLE: 409,
  HAS_MEMBERS: 409,
};
function sendEpicError(reply: FastifyReply, e: EpicGuardError) {
  return reply.status(EPIC_ERROR_STATUS[e.code]).send({ error: e.message, code: e.code });
}

/** Injectable deps for the routes — defaults resolve from the environment / global fetch. */
export interface TaskMonitorRouteDeps {
  /** Write-scoped GitHub token for close-on-delete (PD-207 A). Defaults to `GITHUB_WRITE_TOKEN`. */
  githubWriteToken?: string;
  /** Read-scoped GitHub token for the on-demand sync endpoint (PD-252). Defaults to `GITHUB_READ_TOKEN`. */
  githubReadToken?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  deps: TaskMonitorRouteDeps = {},
): void {
  const base = '/api/widgets/task-monitor';

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

  // On-demand GitHub→board reconciliation (PD-252) is RETIRED at cutover (C6/D-055/PD-347): the
  // board DB is authoritative, so there is nothing to pull from GitHub — and running the old
  // label→board sync here would re-introduce the very coupling bug the cutover fixes (it would
  // overwrite the loop's `in-review`/terminal state from a stale `sortie:*` label). The endpoint is
  // kept as a 200 no-op so the board's "Sync now" / page-load refresh keeps working — it just
  // re-fetches the current (authoritative) DB rows. Removed entirely in C7's sweep.
  app.post(`${base}/sync`, async () => ({ outcome: 'retired' as const }));

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
    if (body.isEpic !== undefined && typeof body.isEpic !== 'boolean') {
      return reply.status(400).send({ error: 'isEpic must be a boolean', code: 'INVALID_IS_EPIC' });
    }
    if (body.epicId !== undefined && body.epicId !== null && !Number.isInteger(body.epicId)) {
      return reply.status(400).send({ error: 'epicId must be an integer or null', code: 'INVALID_EPIC_ID' });
    }

    const input: CreateTicketInput = {
      title: body.title.trim(),
      projectId: body.projectId,
      body: (body.body as string | null | undefined) ?? null,
      priority: body.priority === null ? null : isPriority(body.priority) ? body.priority : undefined,
      assignee: body.assignee === undefined ? undefined : body.assignee === null ? null : (body.assignee as TicketAssignee),
      status: isStatus(body.status) ? body.status : undefined,
      isEpic: body.isEpic === true,
      epicId: body.epicId === undefined ? undefined : (body.epicId as number | null),
    };
    try {
      return reply.status(201).send(createTicket(db, input));
    } catch (e) {
      if (e instanceof EpicGuardError) return sendEpicError(reply, e);
      throw e;
    }
  });

  // Every live Epic's roll-up + derived lane (D-054) — the bulk read the board fetches alongside
  // tickets to place Epic cards and show done/total. Sparse; mirrors the /relations bulk pattern.
  app.get(`${base}/epics`, async () => listEpicSummaries(db));

  // An Epic's member Tickets + its roll-up (D-054) — the Epic detail page's list.
  app.get(`${base}/tickets/:id/members`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!getTicket(db, id)) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    return { members: listEpicMembers(db, id), summary: computeEpicSummary(db, id) };
  });

  // A single ticket by id. The board fetches the full list, but the detail page and API clients
  // want one ticket without filtering client-side.
  app.get(`${base}/tickets/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const ticket = getTicket(db, id);
    if (!ticket) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    return ticket;
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
    if (body.refined !== undefined) {
      if (typeof body.refined !== 'boolean') {
        return reply.status(400).send({ error: 'refined must be a boolean', code: 'INVALID_REFINED' });
      }
      patch.refined = body.refined;
    }
    if (body.isEpic !== undefined) {
      if (typeof body.isEpic !== 'boolean') {
        return reply.status(400).send({ error: 'isEpic must be a boolean', code: 'INVALID_IS_EPIC' });
      }
      patch.isEpic = body.isEpic;
    }
    if (body.epicId !== undefined) {
      if (body.epicId !== null && !Number.isInteger(body.epicId)) {
        return reply.status(400).send({ error: 'epicId must be an integer or null', code: 'INVALID_EPIC_ID' });
      }
      patch.epicId = body.epicId as number | null;
    }

    let updated;
    try {
      updated = updateTicket(db, id, patch);
    } catch (e) {
      // Blocker gate (D-048): can't enter robot_queue with unresolved blockers.
      if (e instanceof QueueBlockedError) {
        return reply.status(409).send({
          error: `blocked by unresolved: ${e.blockers.map((b) => b.displayId ?? b.ticketId).join(', ')}`,
          code: 'BLOCKED_BY_UNRESOLVED',
          blockers: e.blockers,
        });
      }
      // Epic invariants (D-054).
      if (e instanceof EpicGuardError) return sendEpicError(reply, e);
      throw e;
    }
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
    // D-054: for an Epic, `?cascadeMembers=1` archives its members too; otherwise they're unlinked.
    const q = request.query as { cascadeMembers?: string };
    const cascadeMembers = q.cascadeMembers === '1' || q.cascadeMembers === 'true';
    if (!archiveTicket(db, id, { cascadeMembers })) {
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
            `task-monitor: closed ${ref.githubRepo}#${ref.githubIssueNumber} not_planned (ticket ${id} archived)`,
          );
        } else {
          app.log.error(
            `task-monitor: close ${ref.githubRepo}#${ref.githubIssueNumber} failed (ticket ${id} archived)`,
          );
        }
      } catch (err) {
        app.log.error(
          `task-monitor: close ${ref.githubRepo}#${ref.githubIssueNumber} threw: ${err instanceof Error ? err.message : String(err)}`,
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

  // Inline reply to a parked agent (PD-250). DB-native as of C5/PD-346: the reply is recorded as a
  // `robot_human_reply` event the Robot loop's resume sweep detects to re-queue the ticket and hand
  // the answer to the (DB-blind) coding session — no GitHub round-trip required. This replaces the
  // `sortie-ask-human` Action. During the transition (Sortie still primary, loop off) we ALSO mirror
  // the reply to the linked GitHub issue with the human-reply marker, best-effort, so a parked Sortie
  // agent still resumes; a missing issue/token or a GitHub failure no longer fails the reply.
  app.post(`${base}/tickets/:id/reply`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.body !== 'string' || body.body.trim() === '') {
      return reply.status(400).send({ error: 'reply body is required', code: 'INVALID_BODY' });
    }
    const text = body.body.trim();

    // 1) DB-native record — the authoritative signal the loop resumes on. 404 iff the ticket is gone.
    const event = appendRobotReply(db, id, text);
    if (!event) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }

    // 2) Best-effort GitHub mirror for the Sortie transition window. Skipped silently when the ticket
    //    isn't linked or no write token is set; a GitHub failure is logged, never surfaced.
    const ref = getTicketIssueRef(db, id);
    const token = deps.githubWriteToken ?? process.env[GITHUB_WRITE_TOKEN_ENV];
    if (ref?.githubIssueNumber != null && ref.githubRepo && token) {
      const commentBody = `${text}\n\n${HUMAN_REPLY_MARKER}`;
      const ok = await postIssueComment(
        ref.githubRepo,
        ref.githubIssueNumber,
        commentBody,
        token,
        deps.fetchImpl ?? fetch,
      );
      if (!ok) {
        app.log.warn(`task-monitor: GitHub reply mirror to ${ref.githubRepo}#${ref.githubIssueNumber} failed (reply still recorded in DB)`);
      }
    }
    app.log.info(`task-monitor: recorded reply on ticket ${id}`);
    return reply.status(201).send(event);
  });

  /* ── Ticket activity log + Refine thread (D-044, PD-267) ─────────────── */

  // The generic per-ticket activity log (created / status_changed / refine_* / …). The
  // Refine thread is the refine_* subset the ticket-detail page renders; PD-255 will render
  // the rest over this same endpoint. Read-only, no token needed.
  app.get(`${base}/tickets/:id/events`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    return listTicketEvents(db, id);
  });

  // A ticket's Robot runs (C3/PD-344): one row per attempt, newest first, with fault tier +
  // reason + metrics. The ticket-detail run-history table reads this. Read-only, no token needed.
  app.get(`${base}/tickets/:id/runs`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    return listRunsForTicket(db, id);
  });

  /* ── Robot remediation controls (C4/PD-345) — plain DB writes the loop honors next poll ─── */

  // Reset a ticket's transient-retry budget (for a capped/backing-off ticket) and re-dispatch.
  app.post(`${base}/tickets/:id/robot/reset`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    const ticket = resetRobotRuns(db, id, 'reset');
    if (!ticket) return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    return ticket;
  });

  // Unstick a parked ticket (stuck / awaiting-human): clear the park + re-queue it.
  app.post(`${base}/tickets/:id/robot/unstick`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    const ticket = resetRobotRuns(db, id, 'unstick');
    if (!ticket) return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    return ticket;
  });

  // Global pause/resume of Robot dispatch. Resume clears the flag a system-wide fault (C2) set.
  app.post(`${base}/robot/pause`, async (request) => {
    const reason = (request.body as { reason?: string } | null)?.reason;
    return setDispatchPaused(db, true, reason ?? 'paused by human');
  });
  app.post(`${base}/robot/resume`, async () => setDispatchPaused(db, false));

  // Start a Refine session (D-044, PD-268): the Refine button POSTs here. Writes the kickoff
  // refine_human event (ticket title + body) the agent-worker worker polls to open a grounded
  // session. 409 if a thread already exists so a double-click can't spawn a second.
  app.post(`${base}/tickets/:id/refine`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const result = startRefine(db, id);
    if (!result.ok) {
      return result.reason === 'not_found'
        ? reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' })
        : reply.status(409).send({ error: 'refine already started', code: 'ALREADY_STARTED' });
    }
    return reply.status(201).send(result.event);
  });

  // Post a human Refine reply. Unlike /reply (which forwards to a GitHub issue to re-queue a
  // parked Sortie agent), this stays entirely in the DB: it writes a refine_human event the
  // agent-worker consumes on its next poll and resumes the refine session on. No GitHub, no token.
  app.post(`${base}/tickets/:id/refine-reply`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.body !== 'string' || body.body.trim() === '') {
      return reply.status(400).send({ error: 'reply body is required', code: 'INVALID_BODY' });
    }
    const event = appendRefineReply(db, id, body.body.trim());
    if (!event) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    return reply.status(201).send(event);
  });

  /* ── Refine commit step (D-044, PD-269) ──────────────────────────────── */

  // Approve the latest actionable commit proposal. The server (not the agent-worker) does the
  // writes: refine-in-place rewrites+marks refined; decompose creates children (non-queue lanes),
  // closes the parent (D-036), and links them via `split` relations. D-057: approval never
  // dispatches — pass `{ queue: true }` (the "Approve & queue" button, non-Epic refine_in_place
  // only) to also move the ticket into robot_queue in the same step.
  app.post(`${base}/tickets/:id/refine-approve`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const queue = (request.body as { queue?: boolean } | undefined)?.queue === true;
    let result: ApproveRefineResult;
    try {
      result = approveRefine(db, id, { queue });
    } catch (e) {
      // Defensive backstop: approveRefine pre-checks the Epic/blocker invariants, but if any
      // store-level guard escapes we map it to a clean 4xx rather than a 500 (same as POST/PATCH).
      if (e instanceof EpicGuardError) return sendEpicError(reply, e);
      throw e;
    }
    if (result.ok) return reply.status(201).send(result);
    switch (result.reason) {
      case 'not_found':
        return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
      case 'no_proposal':
        return reply.status(409).send({ error: 'no proposal to approve', code: 'NO_PROPOSAL' });
      case 'epic_not_queueable':
        return reply.status(409).send({
          error: `an Epic cannot enter robot_queue: ${result.detail}`,
          code: 'EPIC_NOT_QUEUEABLE',
        });
      case 'blocked_by_unresolved':
        return reply.status(409).send({
          error: `blocked by unresolved: ${result.detail}`,
          code: 'BLOCKED_BY_UNRESOLVED',
        });
      default:
        return reply
          .status(422)
          .send({ error: `invalid proposal: ${result.detail}`, code: 'INVALID_PROPOSAL' });
    }
  });

  // Reject the latest actionable proposal; the refine session can propose again.
  app.post(`${base}/tickets/:id/refine-reject`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const result = rejectRefine(db, id);
    if (result.ok) return reply.status(201).send(result);
    return result.reason === 'not_found'
      ? reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' })
      : reply.status(409).send({ error: 'no proposal to reject', code: 'NO_PROPOSAL' });
  });

  // Every relation on the board as raw rows (PD-322) — the board fetches this once and derives
  // each card's blocked-by/blocking/split badges client-side against tickets it already holds,
  // avoiding one per-card `/tickets/:id/relations` round-trip.
  app.get(`${base}/relations`, async () => listAllRelations(db));

  // Every relation touching the ticket, both directions, resolved (with origin) — the canonical
  // relations resource the UI (PD-322) reads for badges + the detail-page management list
  // (D-048, PD-321). Widened from the PD-269 split-only lineage shape (`TicketLineage`); the
  // detail page derives its split subset client-side by filtering `type === 'split'`.
  app.get(`${base}/tickets/:id/relations`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!getTicket(db, id)) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    return listRelations(db, id);
  });

  // Create a relation (origin='human'). Body is explicit about direction: `from` is the source
  // (for `blocks`, the blocker), `to` the target (the blocked). `id` must be one of them.
  app.post(`${base}/tickets/:id/relations`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fromId = body.fromId;
    const toId = body.toId;
    if (typeof fromId !== 'number' || !Number.isInteger(fromId)) {
      return reply.status(400).send({ error: 'fromId is required', code: 'INVALID_FROM' });
    }
    if (typeof toId !== 'number' || !Number.isInteger(toId)) {
      return reply.status(400).send({ error: 'toId is required', code: 'INVALID_TO' });
    }
    if (!RELATION_TYPES.includes(body.type as RelationType)) {
      return reply.status(400).send({ error: 'invalid relation type', code: 'INVALID_RELATION_TYPE' });
    }
    if (id !== fromId && id !== toId) {
      return reply
        .status(400)
        .send({ error: 'route ticket must be one end of the relation', code: 'ID_MISMATCH' });
    }
    if (!getTicket(db, fromId) || !getTicket(db, toId)) {
      return reply.status(404).send({ error: 'ticket not found', code: 'NOT_FOUND' });
    }
    try {
      const relationId = addRelation(db, fromId, toId, body.type as RelationType, 'human');
      const created = listRelations(db, id).find((r) => r.id === relationId);
      return reply.status(201).send(created);
    } catch (e) {
      if (e instanceof SelfRelationError) {
        return reply.status(400).send({ error: e.message, code: 'SELF_RELATION' });
      }
      if (e instanceof RelationCycleError) {
        return reply
          .status(409)
          .send({ error: e.message, code: 'RELATION_CYCLE', path: e.path });
      }
      throw e;
    }
  });

  // Remove a relation by its row id (the detail-page per-row remove). The relation must touch
  // the route ticket.
  app.delete(`${base}/tickets/:id/relations/:relationId`, async (request, reply) => {
    const params = request.params as { id: string; relationId: string };
    const id = Number(params.id);
    const relationId = Number(params.relationId);
    if (!Number.isInteger(id) || !Number.isInteger(relationId)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const owned = listRelations(db, id).some((r) => r.id === relationId);
    if (!owned) {
      return reply.status(404).send({ error: 'relation not found', code: 'NOT_FOUND' });
    }
    removeRelationById(db, relationId);
    return reply.status(204).send();
  });

  // ── Ticket Audit (D-045, PD-283) ─────────────────────────────────────────────
  // Read-only run/finding views. Apply mechanics (Accept/Reject) land in PD-287.

  app.get(`${base}/audit/runs`, async () => listRuns(db));

  app.get(`${base}/audit/runs/:id/findings`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const run = getRun(db, id);
    if (!run) {
      return reply.status(404).send({ error: 'run not found', code: 'NOT_FOUND' });
    }
    return { run, findings: listFindings(db, id) };
  });

  // Enqueue a run on demand (coalesces onto any pending/running run). The agent-worker
  // executes it; 202 whether created or coalesced, with `created` telling which happened.
  app.post(`${base}/audit/runs`, async (_request, reply) => {
    const { run, created } = insertRequestedRunIfNone(db, null);
    return reply.status(202).send({ run, created });
  });

  // ── System status (Site Status section) ──────────────────────────────────────
  // Two cheap runtime signals for the board header: Sortie fleet counts (pure
  // aggregation over agent_state) + worker liveness (the heartbeat rows workers upsert).
  app.get(`${base}/system-status`, async () => ({
    sortie: getSortieFleet(db),
    workers: listWorkerHeartbeats(db),
    dispatch: getDispatchPauseState(db),
  }));
}
