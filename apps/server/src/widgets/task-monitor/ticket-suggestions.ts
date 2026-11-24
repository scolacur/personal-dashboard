import type Database from 'better-sqlite3';
import {
  TICKET_SUGGESTION_EVENT,
  TICKET_SUGGESTIONS_DECIDED_LIMIT,
  TICKET_SUGGESTIONS_NOTIFICATION_PREFIX,
  resolvedApproval,
  type ApproveSuggestionEdits,
  type FileSuggestionInput,
  type SuggestionFinding,
  type TicketSuggestion,
  type TicketSuggestionStatus,
} from '@dashboard/shared';
import { createNotification, createTicket, getTicket, recordTicketEvent } from './store';

/**
 * Ticket Suggestions store (PD-979, D-116).
 *
 * The Evaluator's leftover non-blocking findings at the revise round cap become one suggestion per
 * PR, which Steve approves / rejects / modifies in the Decisions inbox. Filing is done through
 * `fileTicketSuggestion` (the worker calls it directly on `dashboard.db` at the cap, PD-977 — out of
 * scope here). Approving runs the ordinary `createTicket` path, so every ticket rule still holds: the
 * new ticket lands in `backlog`, unrefined, and under an Epic (D-080).
 */

interface SuggestionRow {
  id: number;
  source_ticket_id: number;
  pr_number: number;
  repo: string | null;
  source: string;
  proposed_title: string;
  proposed_body: string;
  proposed_epic_id: number | null;
  findings: string;
  status: string;
  created_ticket_id: number | null;
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  // joined
  source_display_id: string | null;
  source_title: string | null;
  source_project_id: number | null;
  epic_display_id: string | null;
  epic_title: string | null;
  created_display_id: string | null;
}

const SELECT = `
  SELECT s.*, src.display_id AS source_display_id, src.title AS source_title,
         src.project_id AS source_project_id,
         ep.display_id AS epic_display_id, ep.title AS epic_title,
         ct.display_id AS created_display_id
    FROM ticket_suggestions s
    LEFT JOIN agent_tickets src ON src.id = s.source_ticket_id
    LEFT JOIN agent_tickets ep  ON ep.id = s.proposed_epic_id
    LEFT JOIN agent_tickets ct  ON ct.id = s.created_ticket_id`;

function parseFindings(json: string): SuggestionFinding[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as SuggestionFinding[]) : [];
  } catch {
    return [];
  }
}

function rowTo(row: SuggestionRow): TicketSuggestion {
  return {
    id: row.id,
    sourceTicketId: row.source_ticket_id,
    sourceTicketDisplayId: row.source_display_id,
    sourceTicketTitle: row.source_title,
    sourceProjectId: row.source_project_id,
    prNumber: row.pr_number,
    repo: row.repo,
    source: 'evaluator',
    proposedTitle: row.proposed_title,
    proposedBody: row.proposed_body,
    proposedEpicId: row.proposed_epic_id,
    proposedEpicDisplayId: row.epic_display_id,
    proposedEpicTitle: row.epic_title,
    findings: parseFindings(row.findings),
    status: row.status as TicketSuggestionStatus,
    createdTicketId: row.created_ticket_id,
    createdTicketDisplayId: row.created_display_id,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

function getRow(db: Database.Database, id: number): SuggestionRow | undefined {
  return db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SuggestionRow | undefined;
}

export function getTicketSuggestion(db: Database.Database, id: number): TicketSuggestion | null {
  const row = getRow(db, id);
  return row ? rowTo(row) : null;
}

/**
 * List the pending suggestions (oldest first, so the longest wait is worked first) followed by the
 * most recently decided ones (newest first, capped). `count` is the pending total — what the
 * Decisions badge adds.
 */
export function listTicketSuggestions(
  db: Database.Database,
  decidedLimit: number = TICKET_SUGGESTIONS_DECIDED_LIMIT,
): { items: TicketSuggestion[]; count: number } {
  const pending = (
    db.prepare(`${SELECT} WHERE s.status = 'pending' ORDER BY s.created_at ASC, s.id ASC`).all() as SuggestionRow[]
  ).map(rowTo);
  const decided = (
    db
      .prepare(`${SELECT} WHERE s.status != 'pending' ORDER BY s.decided_at DESC, s.id DESC LIMIT ?`)
      .all(decidedLimit) as SuggestionRow[]
  ).map(rowTo);
  return { items: [...pending, ...decided], count: pending.length };
}

/** The pending suggestion for a PR, if any. The dedup key is `repo + pr_number`. */
function pendingForPr(db: Database.Database, repo: string | null, prNumber: number): SuggestionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM ticket_suggestions
        WHERE status = 'pending' AND pr_number = ? AND repo IS ?`,
    )
    .get(prNumber, repo) as SuggestionRow | undefined;
}

/**
 * File a suggestion for a PR, or UPDATE the existing pending one (one per PR, not one per nit — all
 * of a PR's leftover findings land in a single suggestion). The epic defaults to the source
 * ticket's Epic when not supplied. Posts a Notification Center entry linking to the card; the
 * notification's dedup guard stops a re-file from re-pinging an unread card. Caller validates the
 * input shape (`fileSuggestionError`).
 */
export function fileTicketSuggestion(
  db: Database.Database,
  input: FileSuggestionInput,
  now: number = Date.now(),
): TicketSuggestion {
  const src = getTicket(db, input.sourceTicketId);
  const epicId = input.proposedEpicId !== undefined ? input.proposedEpicId : (src?.epicId ?? null);
  const repo = input.repo ?? null;
  const findingsJson = JSON.stringify(input.findings);
  const source = input.source ?? 'evaluator';

  const id = db.transaction((): number => {
    const existing = pendingForPr(db, repo, input.prNumber);
    if (existing) {
      db.prepare(
        `UPDATE ticket_suggestions
            SET source_ticket_id = ?, source = ?, proposed_title = ?, proposed_body = ?,
                proposed_epic_id = ?, findings = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.sourceTicketId,
        source,
        input.proposedTitle.trim(),
        input.proposedBody,
        epicId,
        findingsJson,
        now,
        existing.id,
      );
      return existing.id;
    }
    const res = db
      .prepare(
        `INSERT INTO ticket_suggestions
           (source_ticket_id, pr_number, repo, source, proposed_title, proposed_body,
            proposed_epic_id, findings, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.sourceTicketId,
        input.prNumber,
        repo,
        source,
        input.proposedTitle.trim(),
        input.proposedBody,
        epicId,
        findingsJson,
        now,
        now,
      );
    return Number(res.lastInsertRowid);
  })();

  recordTicketEvent(db, input.sourceTicketId, TICKET_SUGGESTION_EVENT.filed, {
    suggestionId: id,
    prNumber: input.prNumber,
    findings: input.findings.length,
  });
  const label = src?.displayId ? ` (${src.displayId})` : '';
  createNotification(db, {
    kind: 'agent_ticket_suggestion',
    ticketId: input.sourceTicketId,
    title: `${TICKET_SUGGESTIONS_NOTIFICATION_PREFIX} PR #${input.prNumber}${label}`,
    body: input.proposedTitle.trim(),
  });

  const created = getTicketSuggestion(db, id);
  if (!created) throw new Error('Failed to read back filed ticket suggestion');
  return created;
}

export type ApproveResult =
  | { ok: true; suggestion: TicketSuggestion }
  | { ok: false; reason: 'not_found' | 'already_decided' | 'epic_required' };

export type RejectResult =
  | { ok: true; suggestion: TicketSuggestion }
  | { ok: false; reason: 'not_found' | 'already_decided' };

/**
 * Approve a suggestion — create the real ticket and link it back. Idempotent: approving an
 * already-approved suggestion returns it unchanged (it does NOT create a second ticket); rejecting
 * it first then approving is refused (`already_decided`). The created ticket goes through
 * `createTicket`, so it starts in `backlog`, unrefined, under the chosen Epic (its source ticket's
 * by default). An Epic is required (D-080); `createTicket` throws `EpicGuardError` for a bad one.
 */
export function approveTicketSuggestion(
  db: Database.Database,
  id: number,
  edits: ApproveSuggestionEdits = {},
  now: number = Date.now(),
): ApproveResult {
  const existing = getTicketSuggestion(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status === 'approved') return { ok: true, suggestion: existing };
  if (existing.status === 'rejected') return { ok: false, reason: 'already_decided' };

  const resolved = resolvedApproval(existing, edits);
  if (resolved.epicId === null) return { ok: false, reason: 'epic_required' };

  const src = getTicket(db, existing.sourceTicketId);
  const projectId = src?.projectId;
  if (projectId == null) throw new Error('source ticket has no project');

  const createdId = db.transaction((): number => {
    const ticket = createTicket(db, {
      title: resolved.title,
      body: resolved.body,
      projectId,
      epicId: resolved.epicId,
    });
    db.prepare(
      `UPDATE ticket_suggestions
          SET status = 'approved', created_ticket_id = ?, decided_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(ticket.id, now, now, id);
    recordTicketEvent(db, existing.sourceTicketId, TICKET_SUGGESTION_EVENT.approved, {
      suggestionId: id,
      createdTicketId: ticket.id,
      createdTicketDisplayId: ticket.displayId,
    });
    return ticket.id;
  })();

  markNotificationHandled(db, existing.sourceTicketId, now);
  const after = getTicketSuggestion(db, id);
  if (!after) throw new Error(`suggestion ${id} vanished after approve (created ticket ${createdId})`);
  return { ok: true, suggestion: after };
}

/**
 * Reject a suggestion, with an optional reason. Idempotent: rejecting an already-rejected
 * suggestion returns it unchanged; rejecting an approved one is refused (`already_decided`).
 */
export function rejectTicketSuggestion(
  db: Database.Database,
  id: number,
  reason: string | null = null,
  now: number = Date.now(),
): RejectResult {
  const existing = getTicketSuggestion(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status === 'rejected') return { ok: true, suggestion: existing };
  if (existing.status === 'approved') return { ok: false, reason: 'already_decided' };

  const cleanReason = reason && reason.trim() ? reason.trim().slice(0, 2000) : null;
  db.transaction(() => {
    db.prepare(
      `UPDATE ticket_suggestions
          SET status = 'rejected', reject_reason = ?, decided_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(cleanReason, now, now, id);
    recordTicketEvent(db, existing.sourceTicketId, TICKET_SUGGESTION_EVENT.rejected, {
      suggestionId: id,
      ...(cleanReason ? { reason: cleanReason } : {}),
    });
  })();

  markNotificationHandled(db, existing.sourceTicketId, now);
  const after = getTicketSuggestion(db, id);
  if (!after) throw new Error(`suggestion ${id} vanished after reject`);
  return { ok: true, suggestion: after };
}

/** Clear the waiting notification once the suggestion is decided. */
function markNotificationHandled(db: Database.Database, sourceTicketId: number, now: number): void {
  db.prepare(
    "UPDATE agent_notifications SET read_at = ? WHERE ticket_id = ? AND kind = 'agent_ticket_suggestion' AND read_at IS NULL",
  ).run(now, sourceTicketId);
}
