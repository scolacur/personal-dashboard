import type { AgentTicket, CoderArea, TicketAssignee, TicketKind, TicketPriority, TicketStatus } from '@dashboard/shared';
import { ROBOT_MAX_TURNS_LIMIT } from '@dashboard/shared';

/**
 * An Epic to mint on save, with this Ticket as its first member (D-080 slice C).
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
  /** PD-896: bug / feature / chore; null = unclassified. Not offered on an Epic. */
  kind: TicketKind | null;
  /** PD-955 (PD-880): the Coder code-area. On a Ticket, null means "inherit from Epic"; on an Epic,
   *  null means "— None" (members then fall back to `general`). */
  coderArea: CoderArea | null;
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
    kind: null,
    coderArea: null,
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
    kind: ticket.kind,
    coderArea: ticket.coderArea,
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
 * Whether this save must end with the Ticket inside an Epic (D-080 slice C).
 *
 * Stated as a rule about the **transition**, not about the state, which is what makes the legacy
 * question mostly evaporate:
 *
 *  - **Creating** — always. Never mint a new orphan.
 *  - **Editing a Ticket that has an Epic** — always. A Ticket may be moved to another Epic, never
 *    out of one; un-parenting is what the model has no answer for, since priority and dispatch both
 *    come from the Epic. An orphaned active Ticket is unpriced and undispatchable by construction.
 *  - **Editing a Ticket that has no Epic** — only while it is still active. The board holds ~141
 *    terminal tickets that predate the rule; requiring one there would enforce the model against
 *    history, and giving each its own Epic in a backfill would add ~125 single-member Epics to the
 *    Completed band, which is a worse board than the one we have.
 */
export function epicRequired(ctx: {
  creating: boolean;
  /** The Epic the ticket had before this edit (not the form's current value). */
  hadEpic: boolean;
  status: TicketStatus;
}): boolean {
  if (ctx.creating) return true;
  if (ctx.hadEpic) return true;
  return ctx.status !== 'completed' && ctx.status !== 'closed';
}

/**
 * Why the form cannot be saved yet, or null when it can.
 *
 * `requireEpic` comes from `epicRequired()` — see there for why it is a rule about the transition
 * rather than about the state.
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

/** One thing a save checks or does, shown while it runs. `mint` happens first, client-side;
 *  everything else is the server's single PATCH. */
export interface SaveCheck {
  stage: 'mint' | 'server';
  label: string;
}

/**
 * What saving `form` over `existing` will check, in the order the server checks it — for the
 * edit modal's loading state, so a slow save says what it is waiting on rather than just spinning.
 *
 * Only the checks this particular edit can trip are listed: a title tweak says "Saving changes"
 * and nothing else, while moving robot work into the Queue names the Queue gate. The list mirrors
 * the PATCH route (`task-monitor/routes.ts`): patch guards → D-097 refined choice → D-091 Queue
 * gate → Epic invariants and the stale-Epic pause (D-054, D-089) → priority cascade (D-080).
 */
export function saveChecks(existing: AgentTicket, form: TicketFormState): SaveCheck[] {
  const checks: SaveCheck[] = [];
  const draftingEpic = !form.isEpic && form.newEpic !== null && form.newEpic.title.trim() !== '';
  if (draftingEpic) {
    checks.push({ stage: 'mint', label: `Creating the Epic “${form.newEpic!.title.trim()}”` });
  }
  const server = (label: string) => checks.push({ stage: 'server', label });

  const body = form.body.trim() || null;
  if (existing.refined && body !== (existing.body ?? null)) {
    server('Refinement — the description changed on a refined ticket');
  }
  const epicId = form.isEpic ? null : form.epicId;
  // Mirrors `queueGuardFailure`: judged on entering the Robot's Queue, or changing Epic while in it.
  const wasRobotQueued = existing.status === 'queue' && existing.assignee === 'robot';
  if (
    !form.isEpic &&
    form.status === 'queue' &&
    form.assignee === 'robot' &&
    !(wasRobotQueued && epicId === existing.epicId && !draftingEpic)
  ) {
    server('Queue gate — refined, Ready sections, its Epic, open blockers');
  }
  if (draftingEpic || form.isEpic !== existing.isEpic || epicId !== existing.epicId) {
    server('Epic rules — membership, and pausing a refined Epic it joins');
  }
  if (form.isEpic && form.priority !== existing.priority) {
    server('Priority — cascading to every member');
  }
  server('Saving changes');
  return checks;
}
