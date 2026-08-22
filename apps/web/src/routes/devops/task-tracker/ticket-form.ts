import type { AgentTicket, TicketAssignee, TicketPriority, TicketStatus } from '@dashboard/shared';
import { ROBOT_MAX_TURNS_LIMIT } from '@dashboard/shared';

/**
 * An Epic to mint on save, with this Ticket as its first member (D-TMP-PD383a slice C).
 *
 * It carries a priority because that is the whole point: priority is an Epic property, so the
 * moment you create work that belongs to no existing Epic you are also deciding how urgent it is.
 * Offering the Epic without the priority would just move the unclassified-Epic problem one step
 * later, and the board already has a backlog of Epics nobody ever priced.
 */
export interface NewEpicDraft {
  title: string;
  priority: TicketPriority | null;
}

/**
 * The add/edit modal's field values. Held as one `$state` object on the page and mutated in place
 * by the modal, so the page keeps the submit/bypass logic (which needs to read the fields) without
 * threading a dozen `$bindable` props through the boundary.
 */
export interface TicketFormState {
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority | null;
  assignee: TicketAssignee | null;
  /** D-054: whether this ticket is an Epic. The board's Epic `+` and the form checkbox both set it. */
  isEpic: boolean;
  /** D-054: which Epic this ticket belongs to; null = none. Forced null when `isEpic`. */
  epicId: number | null;
  /** When set, an Epic is created on save and this Ticket becomes its first member; `epicId` is
   *  then ignored. Null means "use `epicId`". */
  newEpic: NewEpicDraft | null;
  /** PD-432: the per-ticket run ceiling as typed text, so an empty field is unambiguously
   *  "default" rather than 0. Parsed on submit. */
  maxTurns: string;
  projectId: number | null;
}

/** A blank form for a new ticket in `status`. Priority starts unset — it is assigned deliberately. */
export function emptyTicketForm(status: TicketStatus, projectId: number | null): TicketFormState {
  return {
    title: '',
    body: '',
    status,
    priority: null,
    assignee: null,
    isEpic: false,
    epicId: null,
    newEpic: null,
    maxTurns: '',
    projectId,
  };
}

/** The form pre-filled from an existing ticket. */
export function ticketToForm(ticket: AgentTicket, fallbackProjectId: number | null): TicketFormState {
  return {
    title: ticket.title,
    body: ticket.body ?? '',
    status: ticket.status,
    priority: ticket.priority,
    assignee: ticket.assignee,
    isEpic: ticket.isEpic,
    epicId: ticket.epicId,
    newEpic: null,
    maxTurns: ticket.maxTurns === null ? '' : String(ticket.maxTurns),
    projectId: ticket.projectId ?? fallbackProjectId,
  };
}

/**
 * Whether the typed turn ceiling is out of bounds. Checked client-side as well as server-side so
 * Save is blocked with an explanation rather than the write failing after the fact — the bound is
 * a rule worth learning, not an error to hit.
 */
export function maxTurnsInvalid(raw: string): boolean {
  const t = raw.trim();
  if (t === '') return false;
  const n = Number(t);
  return !Number.isInteger(n) || n < 1 || n > ROBOT_MAX_TURNS_LIMIT;
}

/**
 * Why the form cannot be saved yet, or null when it can.
 *
 * `requireEpic` is on for **creation only** (D-TMP-PD383a slice C: "a Ticket cannot be created
 * without an Epic"). Editing deliberately does not enforce it: the board still holds ~141 terminal
 * tickets that predate the rule, and blocking a typo fix on one of them would enforce the model
 * against history rather than against new work.
 */
export function ticketFormError(
  form: TicketFormState,
  { requireEpic }: { requireEpic: boolean },
): string | null {
  if (!form.title.trim()) return 'A title is required.';
  if (form.projectId === null) return 'Pick a project.';
  // An Epic never belongs to another Epic (no nesting, D-054), so the requirement never applies.
  if (!form.isEpic) {
    if (form.newEpic !== null) {
      if (!form.newEpic.title.trim()) return 'Name the new Epic.';
    } else if (requireEpic && form.epicId === null) {
      return 'Every Ticket belongs to an Epic — pick one, or create a new one.';
    }
  }
  if (maxTurnsInvalid(form.maxTurns)) {
    return `Turn ceiling must be a whole number between 1 and ${ROBOT_MAX_TURNS_LIMIT}.`;
  }
  return null;
}
