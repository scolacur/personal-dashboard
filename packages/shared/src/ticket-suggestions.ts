// Ticket Suggestions (PD-979, D-116).
//
// When the Evaluator reaches the revise round cap (`MAX_EVALUATION_ROUNDS`) with non-blocking
// findings still open, the PR ships anyway (PD-977) and the leftover findings are NOT dropped:
// they are bundled into a **Ticket Suggestion**. Steve approves / rejects / modifies it in the
// Decisions inbox; approving creates a real backlog ticket through the ordinary create path.
//
// Filing a suggestion from the Evaluator is the worker's job at the round cap (PD-977) and is out
// of scope here. This module is the shared shape plus the pure validators/formatters the store,
// the routes and the web page all read from one place.

export const TICKET_SUGGESTION_SOURCES = ['evaluator'] as const;
export type TicketSuggestionSource = (typeof TICKET_SUGGESTION_SOURCES)[number];
export function isTicketSuggestionSource(x: unknown): x is TicketSuggestionSource {
  return typeof x === 'string' && (TICKET_SUGGESTION_SOURCES as readonly string[]).includes(x);
}

export const TICKET_SUGGESTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type TicketSuggestionStatus = (typeof TICKET_SUGGESTION_STATUSES)[number];

/** A single leftover finding bundled into a suggestion — the reporting subset of `EvaluatorFinding`. */
export interface SuggestionFinding {
  /** The finding category, e.g. `convention`, `readability`, `test-gap`. */
  kind: string;
  /** Where it is, `path:line` when known. */
  where: string;
  /** The defect in one sentence. */
  what: string;
}

export interface TicketSuggestion {
  id: number;
  /** The ticket whose PR produced the findings. */
  sourceTicketId: number;
  sourceTicketDisplayId: string | null;
  sourceTicketTitle: string | null;
  /** The source ticket's project — scopes the epic picker to same-project Epics (D-080). */
  sourceProjectId: number | null;
  prNumber: number;
  /** `owner/repo` the PR lives in; null for a legacy/unknown repo. */
  repo: string | null;
  source: TicketSuggestionSource;
  proposedTitle: string;
  proposedBody: string;
  /** Defaults to the source ticket's Epic at filing time; editable on approve. */
  proposedEpicId: number | null;
  proposedEpicDisplayId: string | null;
  proposedEpicTitle: string | null;
  findings: SuggestionFinding[];
  status: TicketSuggestionStatus;
  /** The ticket created when approved; null until then. */
  createdTicketId: number | null;
  createdTicketDisplayId: string | null;
  /** The reason given when rejected; null otherwise. */
  rejectReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** When it was approved or rejected; null while pending. */
  decidedAt: number | null;
}

/** Input to file (or merge-update) a suggestion for a PR. Worker-side at the round cap (PD-977). */
export interface FileSuggestionInput {
  sourceTicketId: number;
  prNumber: number;
  repo?: string | null;
  source?: TicketSuggestionSource;
  proposedTitle: string;
  proposedBody: string;
  /** Omit/null to inherit the source ticket's Epic (resolved by the store). */
  proposedEpicId?: number | null;
  findings: SuggestionFinding[];
}

/** Optional per-field edits Steve applies when approving (Modify). An omitted field keeps the
 *  proposed value; this is why they are all optional rather than the full proposal re-sent. */
export interface ApproveSuggestionEdits {
  title?: string;
  body?: string;
  epicId?: number | null;
}

export interface SuggestionValidationError {
  message: string;
  code: string;
}

/** The notification title prefix, followed by "PR #N (PD-x)". */
export const TICKET_SUGGESTIONS_NOTIFICATION_PREFIX = 'Ticket suggestion:';

/** Timeline event types recorded on the SOURCE ticket (not Robot events — these are plain ticket
 *  activity, like `created` / `status_changed`). */
export const TICKET_SUGGESTION_EVENT = {
  filed: 'suggestion_filed',
  approved: 'suggestion_approved',
  rejected: 'suggestion_rejected',
} as const;
export type TicketSuggestionEventType =
  (typeof TICKET_SUGGESTION_EVENT)[keyof typeof TICKET_SUGGESTION_EVENT];

/** How many recently-decided suggestions the inbox shows alongside the pending ones. */
export const TICKET_SUGGESTIONS_DECIDED_LIMIT = 10;

/** Shape-validate a file input. Returns the first problem, or null when it may be filed. */
export function fileSuggestionError(input: FileSuggestionInput): SuggestionValidationError | null {
  if (!Number.isInteger(input.sourceTicketId) || input.sourceTicketId <= 0) {
    return { message: 'sourceTicketId must be a positive integer', code: 'INVALID_SOURCE_TICKET' };
  }
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return { message: 'prNumber must be a positive integer', code: 'INVALID_PR_NUMBER' };
  }
  if (input.source !== undefined && !isTicketSuggestionSource(input.source)) {
    return { message: `source must be one of ${TICKET_SUGGESTION_SOURCES.join(', ')}`, code: 'INVALID_SOURCE' };
  }
  if (typeof input.proposedTitle !== 'string' || input.proposedTitle.trim() === '') {
    return { message: 'proposedTitle is required', code: 'INVALID_TITLE' };
  }
  if (typeof input.proposedBody !== 'string') {
    return { message: 'proposedBody must be a string', code: 'INVALID_BODY' };
  }
  if (!Array.isArray(input.findings) || input.findings.length === 0) {
    return { message: 'a suggestion bundles at least one finding', code: 'NO_FINDINGS' };
  }
  for (const f of input.findings) {
    if (!f || typeof f.kind !== 'string' || typeof f.where !== 'string' || typeof f.what !== 'string') {
      return { message: 'each finding needs kind, where and what', code: 'INVALID_FINDING' };
    }
  }
  return null;
}

/** Shape-validate approve edits. An empty title is refused; an empty body is allowed (a title can
 *  carry the whole suggestion). Returns the first problem, or null. */
export function approveSuggestionError(edits: ApproveSuggestionEdits): SuggestionValidationError | null {
  if (edits.title !== undefined && (typeof edits.title !== 'string' || edits.title.trim() === '')) {
    return { message: 'title cannot be blank', code: 'INVALID_TITLE' };
  }
  if (edits.body !== undefined && typeof edits.body !== 'string') {
    return { message: 'body must be a string', code: 'INVALID_BODY' };
  }
  if (edits.epicId !== undefined && edits.epicId !== null && !Number.isInteger(edits.epicId)) {
    return { message: 'epicId must be an integer or null', code: 'INVALID_EPIC_ID' };
  }
  return null;
}

/** The effective title / body / epic a suggestion approves with: edits applied over the proposal. */
export function resolvedApproval(
  s: Pick<TicketSuggestion, 'proposedTitle' | 'proposedBody' | 'proposedEpicId'>,
  edits: ApproveSuggestionEdits = {},
): { title: string; body: string; epicId: number | null } {
  return {
    title: (edits.title ?? s.proposedTitle).trim(),
    body: edits.body ?? s.proposedBody,
    epicId: edits.epicId !== undefined ? edits.epicId : s.proposedEpicId,
  };
}

/** A one-line human string for a finding — the card and any log line render the same words. */
export function findingLine(f: SuggestionFinding): string {
  const where = f.where.trim();
  return where ? `${f.kind} — ${where}: ${f.what}` : `${f.kind}: ${f.what}`;
}
