// Types for the Task Monitor "Tasks" Kanban — the project's Ticket backlog.
// Shared between the server (DB + API) and the web (Kanban UI).

// Type-only, and one-directional: `agent-prompts.ts` imports nothing, so this cannot cycle.
import type { EvaluatorVerdict } from './agent-prompts';
import type { RefineAnswerSet, RefineQuestionRound } from './refine-questions';

// Who the ticket is assigned to. 'steve' = human owner; 'robot' = the Robot loop.
// null = unassigned.
export type TicketAssignee = 'steve' | 'robot';

export const TICKET_ASSIGNEES: readonly TicketAssignee[] = ['steve', 'robot'] as const;

/** Short label for each assignee value (shown in the create/edit modal). */
export const ASSIGNEE_LABELS: Record<TicketAssignee, string> = {
  steve: 'Steve',
  robot: 'Robot',
};

/**
 * The assignee a lane forces on entry, or `null` if the lane leaves assignee free.
 *
 * D-058 REVERSES D-055/D-044: assignee is no longer forced by the lane. The two queue
 * lanes collapsed into one `queue` status and `assignee` became an independent axis —
 * settable at any stage, never overridden by the lane. So this returns `null` for
 * EVERY status now (kept as a function so callers need no signature change; a later
 * cleanup ticket may drop it entirely). Dispatch is decided by
 * `status='queue' AND assignee='robot' AND (ready OR ready_bypassed) AND unblocked`,
 * not by a lane forcing the assignee.
 */
export function laneForcedAssignee(_status: TicketStatus): TicketAssignee | null {
  return null;
}

// The Kanban lanes (DECISIONS D-040 board redesign, PD-245; D-058 collapse; D-080 drops
// `prioritized`). Four statuses.
//  - backlog: the default lane. The `prioritized` lane it absorbed was never carrying priority —
//    it was carrying *commitment*, which D-080 re-expresses by queueing the Epic.
//  - queue: ONE queue lane (D-058, collapses the old robot_queue + steve_queue). Who does the
//    work is the independent `assignee` axis: `robot` + queued + Ready = fair game for the loop;
//    `steve` + queued = the personal to-do lane; `null` + queued = queued-but-unassigned. Every
//    non-terminal agent state lives here; the fine state (queued/in-progress/in-review/…) is
//    carried by `agentState` and shown as a status pill. Under D-080 a Ticket does not enter it
//    by hand — its **Epic** is queued and its members follow.
//  - completed: agent-set terminal (the Robot loop's PR merged), or hand-set for work assigned to
//    a human. closed: manual/wontfix terminal (D-036), hidden by default.
export type TicketStatus = 'backlog' | 'queue' | 'completed' | 'closed';

// Priority is a P0–P5 scale (P0 most urgent). A ticket's priority may also be
// *unset* — represented as `null` in the domain/API (see AgentTicket.priority).
export type TicketPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

// Fine-grained agent state, owned by the Robot loop (D-055). In the redesigned board
// (D-040/D-058) every non-terminal agent state maps to the single `queue` status, so
// `agentState` is what distinguishes them on the card (rendered as a status pill). Only
// 'working' drives the active-work shimmer; 'stuck'/'needs-human'/'awaiting-human' are
// paused-need-attention; 'queued'/'in-review' are informational; 'done' is terminal (the
// ticket sits in the `completed` lane but keeps a green pill so a Robot-completed ticket is
// distinguishable from a manually-closed one). `null` = no agent state (manual / not worked).
export type AgentState =
  | 'queued'
  | 'working'
  | 'in-review'
  | 'stuck'
  | 'needs-human'
  | 'awaiting-human'
  | 'wontfix'
  | 'done';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'backlog',
  'queue',
  'completed',
  'closed',
] as const;

/**
 * Coerce a possibly-legacy status string to a valid `TicketStatus`, or `null` if unrecognized
 * (D-058, PD-417). The pre-D-058 queue lanes (`robot_queue` / `steve_queue`) collapse to the single
 * `queue` lane — a stale Refine proposal or an un-redeployed agent may still carry them, and they'd
 * otherwise be written verbatim into an invalid lane (renders in no board column, never dispatched,
 * bypasses the epic/blocker gates). The write-boundary guard (`createTicket`/`updateTicket`) and
 * `approveRefine` run every status through this so an invalid lane can never be persisted.
 */
export function coerceTicketStatus(status: string): TicketStatus | null {
  if ((TICKET_STATUSES as readonly string[]).includes(status)) return status as TicketStatus;
  if (status === 'robot_queue' || status === 'steve_queue') return 'queue';
  // D-080: the retired `prioritized` lane folds into `backlog`, for the same reason the pre-D-058
  // queue lanes fold into `queue` — a stale Refine proposal or an un-redeployed agent can still
  // carry it, and writing it verbatim would produce a row in no board column.
  if (status === 'prioritized') return 'backlog';
  return null;
}

export const TICKET_PRIORITIES: readonly TicketPriority[] = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
] as const;

/** Short label for each priority level (shown in the priority legend). */
export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  P0: 'Urgent',
  P1: 'Top Priority',
  P2: 'Important',
  P3: 'Medium Importance',
  P4: 'Low Importance',
  P5: 'Window Dressing',
};

/** Short labels for each agent state (displayed in pills and the status-legend modal). */
// Display names for the pill (and the glossary). PD-536: `queued` reads as "waiting", not
// "queued" — the card already sits in a lane called Queue, so "queued" restated the column while
// the thing worth knowing is that the loop has not started it yet. That freed "in progress" to
// mean one thing (a live session) rather than also naming the Epic band's lane.
export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  queued: 'waiting',
  working: 'in progress',
  'in-review': 'in review',
  stuck: 'stuck',
  'needs-human': 'PR closed unmerged',
  'awaiting-human': 'awaiting human',
  wontfix: 'wontfix',
  done: 'done',
};

/**
 * Per-run turn ceiling the Robot loop enforces (`ROBOT_MAX_TURNS`). Declared here so the board's
 * denominator and the loop's real cap cannot drift **in code** — the agent-worker's config default
 * reads this constant (PD-230).
 *
 * Caveat: an env override on the deploy host (`ROBOT_MAX_TURNS=...`) is NOT visible to the web
 * process, which has no access to the worker's env. The board would then show the wrong
 * denominator. Not overridden today; if that changes, surface the live value on the worker
 * heartbeat rather than guessing here.
 */
export const ROBOT_MAX_TURNS_DEFAULT = 50;

/**
 * Hard upper bound for a per-ticket `max_turns` override (PD-432). An override exists so an
 * irreducible ticket can finish; it does not exist to authorise an unbounded burn, so a value above
 * this is rejected at the write boundary rather than clamped — a silently-lowered ceiling would
 * mislead whoever set it.
 */
export const ROBOT_MAX_TURNS_LIMIT = 200;

/** At/above this fraction of the ceiling a run is flagged as close to the cap. */
export const TURN_WARN_FRACTION = 0.8;

/** Agent states for which turn progress is meaningful. `working` is the live case; `in-review`
 *  and `stuck` are post-mortem — `stuck` is where the ceiling actually bites, so it earns a slot
 *  (a card reading "50/50" explains itself at a glance). */
export const TURN_PROGRESS_STATES: readonly AgentState[] = ['working', 'in-review', 'stuck'];

export interface TurnProgress {
  turns: number;
  max: number;
  /** Compact display form, e.g. "43/50". */
  label: string;
  /** True once the run is at/over TURN_WARN_FRACTION of the ceiling. */
  nearCap: boolean;
  /** True when the run met or passed the ceiling — it ran out of budget. */
  atCap: boolean;
}

/**
 * Derive turn-progress display data, or null when there is nothing meaningful to show.
 *
 * Deliberately does NOT clamp `turns` to `max`: the SDK can report one turn past the ceiling
 * (PD-412's run #12 recorded 51 against a cap of 50), and "51/50" is more honest — and more
 * diagnostic — than a clamped "50/50".
 */
export function turnProgress(
  turns: number | null | undefined,
  max: number = ROBOT_MAX_TURNS_DEFAULT,
): TurnProgress | null {
  if (typeof turns !== 'number' || !Number.isFinite(turns) || turns <= 0) return null;
  const ceiling = Number.isFinite(max) && max > 0 ? max : ROBOT_MAX_TURNS_DEFAULT;
  return {
    turns,
    max: ceiling,
    label: `${turns}/${ceiling}`,
    nearCap: turns >= ceiling * TURN_WARN_FRACTION,
    atCap: turns >= ceiling,
  };
}

/** Should this ticket's card/pill show turn progress? */
export function showsTurnProgress(
  agentState: AgentState | null | undefined,
  turns: number | null | undefined,
): boolean {
  if (!agentState || !TURN_PROGRESS_STATES.includes(agentState)) return false;
  return turnProgress(turns) !== null;
}

// These stay PLAIN TEXT: the status-legend modal renders them via `{...}` interpolation
// (apps/web/.../task-monitor/+page.svelte), so any inline markdown/HTML would show as literal
// syntax. The concepts named below — in-process stall detection, the Robot loop, ask_human,
// the agent-state machine — are documented in docs/robot.md, which the legend modal links to
// via a "Robot loop wiki" footer link rather than by embedding markup in these strings
// (PD-262). See also #145 (Karpathy memory model).
/** One-sentence descriptions for each agent state, shown in the status-legend modal. */
export const AGENT_STATE_DESCRIPTIONS: Record<AgentState, string> = {
  // Not "picked up by the loop" — it is precisely the state of NOT having been picked up yet
  // (`robotQueueCandidates` selects on `agent_state IS NULL OR 'queued'`).
  queued: "In the Queue and eligible for dispatch — the loop hasn't started it yet.",
  working: 'A Robot run is actively working the ticket right now.',
  'in-review': 'The run succeeded and a PR is open, awaiting human review.',
  stuck:
    'The run stalled/gave up and was flagged by in-process stall detection; needs human intervention.',
  // The ONLY writer of this state is `pollInReviewPrs` on a PR that went CLOSED without merging
  // (pr-state.ts). There is no review-feedback cap anywhere in the loop — `decideReactivation`
  // re-activates on any trusted feedback, unboundedly — so the previous wording described a
  // mechanism that does not exist.
  'needs-human':
    "A human closed the Robot's PR without merging it. The loop will not touch the ticket again on its own.",
  'awaiting-human':
    'The agent deliberately paused after asking a question (ask_human) and is waiting on a reply. Least urgent / expected.',
  wontfix: "Terminal: the ticket was closed as won't-fix.",
  done: 'Terminal: the Robot loop finished the work and the PR merged (green pill; lives in the Completed lane).',
};

/** Longer descriptions for the priority-legend modal. */
export const PRIORITY_DESCRIPTIONS: Record<TicketPriority, string> = {
  P0: 'Reserved for time-sensitive things like open security threats, leaked credentials, etc.',
  P1: 'Top priority.',
  P2: 'Important.',
  P3: 'Medium importance.',
  P4: 'Low importance.',
  P5: 'Window dressing.',
};

/**
 * Short labels for each refinement session state (shown in pills and the glossary modal).
 *
 * PD-536: both states say **Refining…**, because both ARE the same activity — an open refine
 * session. What differs is only whose turn it is, which the emoji carries: 🤖 the agent is
 * thinking, 💬 it asked something and is waiting on you. The old pair ("Refining…" / "Needs you")
 * read as two unrelated states and buried the one thing worth acting on.
 */
export const REFINE_STATE_LABELS: Record<RefineState, string> = {
  refining: 'Refining… 🤖',
  'awaiting-human': 'Refining… 💬',
};

/** One-sentence descriptions for each refinement session state, shown in the glossary modal. */
export const REFINE_STATE_DESCRIPTIONS: Record<RefineState, string> = {
  refining: "A refine session is open and it's the agent's turn — it is working on the ticket now.",
  'awaiting-human':
    'A refine session is open and it is YOUR turn — the agent asked something and is waiting on your reply or approval.',
};

// A project the Tickets belong to (personal-dashboard, core, nervous-system-website, …).
// The dashboard tracks Tickets across all projects, not just itself.
export interface AgentProject {
  id: number;
  slug: string;
  name: string;
  /** Display-id prefix, e.g. 'PD' → tickets are PD-1, PD-2, … */
  key: string | null;
  /** 'owner/repo' for Phase-3 issue creation; null if the project isn't on GitHub. */
  githubRepo: string | null;
  /** Whether the Robot loop is enabled for this project. */
  robotEnabled: boolean;
  /** Hex color for the project chip on cards. */
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  githubRepo?: string | null;
  robotEnabled?: boolean;
  color?: string | null;
}

export interface AgentTicket {
  id: number;
  /** Human-facing per-project id, e.g. 'PD-7'. Null only for legacy rows. */
  displayId: string | null;
  title: string;
  body: string | null;
  status: TicketStatus;
  /** P0–P5, or `null` when priority is unset. */
  priority: TicketPriority | null;
  /** The project this Ticket belongs to. */
  projectId: number | null;
  /** Human or agent that owns the ticket. */
  assignee: TicketAssignee | null;
  /** Recurrence hint for maintenance tickets, e.g. 'weekly'. */
  recurInterval: string | null;
  /** 'manual', or 'seed:<path>' for tickets imported from a TODO.md/META-TODOS.md file. */
  source: string;
  /** Ordering within a column (ascending); fractional to allow drag-reorder. */
  sortOrder: number;
  /** Set when the Ticket is converted to a GitHub issue (Phase 3). */
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  /** Fine-grained agent state owned by the Robot loop (D-055); null = none. */
  agentState: AgentState | null;
  /** Turns used by the ticket's LATEST Robot run (PD-230), or null when there is no run yet /
   *  the worker has never run. Live-updated during a `working` run, then overwritten with the
   *  SDK's authoritative `num_turns` when the run finishes. Read-only, server-derived. */
  agentTurns: number | null;
  /** Live Refine session state derived from the ticket's refine_* thread (D-044, PD-268);
   *  null = no Refine session started. */
  refineState: RefineState | null;
  /** Whether this ticket has been refined to completion at least once (D-044, PD-268).
   *  Persistent marker: gates the Refine button (hidden once true) and shows a ✓. Flipped
   *  by the commit/approval step (PD-269) or the manual "Mark refined" control. */
  refined: boolean;
  /**
   * Set when this Epic WAS refined and its member set has changed since (D-089, PD-610).
   *
   * The third state `refined` alone cannot express. `refined = 0` otherwise means "never refined",
   * which is the ordinary condition of almost every Epic and must not raise a warning; this
   * distinguishes the one that made a claim and had it invalidated.
   *
   * Only ever set on an Epic — on an Epic, `refined` asserts both that the description frames the
   * work AND that the current member set is the agreed breakdown of it, and this marks the second
   * half going stale. Cleared by re-refining.
   */
  refineStale: boolean;
  /** PD-748: this Epic is switched out of the Refine backfill (its members inherit it). Optional so
   *  fixtures predating it still type-check; absent reads as false. */
  backfillExcluded?: boolean;
  /** D-103 (PD-808): this Epic is excluded from auto-queue — set by hand on Robot / Osiris / infra
   *  Epics so the promoter never auto-queues self-modifying work. Meaningful on Epics only (default
   *  false); a member reads its own column, and the promoter also checks the member's Epic. Optional
   *  so fixtures predating it still type-check; absent reads as false. */
  autoQueueExcluded?: boolean;
  /** Whether the body is Robot-ready — the mechanical 4-section shape check (`isReady`),
   *  recomputed on every body write and persisted (D-058). Server-computed, NOT client-settable
   *  (absent from Create/UpdateTicketInput). A bypassable dispatch gate; refinement is the hard one
   *  (D-091, `queueBlockers`). */
  ready: boolean;
  /** Set when a human queued a not-Ready robot ticket through the confirm modal (D-058, PD-399).
   *  The loop gate is `ready || readyBypassed`; goes moot once the body is fixed (recompute makes
   *  `ready` true). Never fakes `ready`, so the board can show an honest "⚠ bypassed" badge. */
  readyBypassed: boolean;
  /** Per-ticket run ceiling (PD-432); `null` = inherit the loop's env default. Set when a ticket
   *  genuinely cannot be decomposed to fit — raising the cap is the escape hatch, not the default.
   *  Bounded by `ROBOT_MAX_TURNS_LIMIT` so a bad estimate cannot authorise an unbounded burn. */
  maxTurns: number | null;
  /** True when this Ticket is an Epic umbrella (D-054, PD-336). An Epic groups member Tickets,
   *  is never dispatched (cannot enter `queue`), and its board status is derived. */
  isEpic: boolean;
  /** The single parent Epic this Ticket belongs to, or null. An Epic itself always has this null
   *  (no nesting). "Belongs to" — not "child of"; parent/child is reserved for `split` lineage. */
  epicId: number | null;
  /** D-103 (PD-811): this ticket's most recent lane change into the Queue was made by the auto-queue
   *  promoter (an `auto_queued` event newer than any manual `status_changed`), not by hand. Drives
   *  the card's "auto-queued" badge. Server-derived, read-only; absent reads as false. */
  autoQueued?: boolean;
  /** Soft-delete timestamp; null = active. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted when creating a Ticket. New items land in `backlog` unless `status` is given. */
export interface CreateTicketInput {
  title: string;
  projectId: number;
  body?: string | null;
  /** P0–P5, or `null`/omitted for unset. */
  priority?: TicketPriority | null;
  /** Override the initial status (used by the seed importer for completed items). */
  status?: TicketStatus;
  /** Provenance, e.g. 'seed:widgets/pomodoro-timer/TODO.md'. Defaults to 'manual'. */
  source?: string;
  /**
   * Force a specific display-id (e.g. 'PD-42') instead of allocating the next one.
   * Used only by the seed importer to preserve ids across a restore; normal creates
   * (API, UI) omit this and get the next per-project id. The project's `seq` counter
   * is advanced past the forced number so later auto-allocations don't collide.
   */
  displayId?: string | null;
  /** Who the ticket is assigned to. Defaults to `null` when omitted. */
  assignee?: TicketAssignee | null;
  /** Recurrence hint, e.g. 'weekly'. Carried forward to the spawned next occurrence. */
  recurInterval?: string | null;
  /** Create this Ticket as an Epic umbrella (D-054). Defaults false. */
  isEpic?: boolean;
  /** Parent Epic id, or null. Ignored when `isEpic` is true (no nesting). */
  epicId?: number | null;
  /** Per-ticket run ceiling (PD-432); omit or null to inherit the loop's default. Rejected above
   *  `ROBOT_MAX_TURNS_LIMIT`. */
  maxTurns?: number | null;
}

/**
 * Where a suggestion ticket was filed from (PD-578 front door). Three scopes, narrowest first:
 * a widget card's +, the "Suggest a change" footer at the bottom of every page, and the
 * app-wide button in the top nav. Server-side each becomes a backlog Ticket in the triage-inbox
 * Epic, stamped `source = 'widget:<id>' | 'page:<route>' | 'app'`.
 */
export type TicketSurface =
  | {
      kind: 'widget';
      widgetId: string;
      widgetTitle: string;
      /** The widget's own page, e.g. `/widgets/acute-strategies-generator`. */
      route: string;
    }
  | {
      kind: 'page';
      /** The page's display name, as the top nav shows it. */
      pageTitle: string;
      /** The pathname the suggestion was filed from, e.g. `/productivity`. */
      route: string;
    }
  | { kind: 'app' };

export interface SurfaceTicketInput {
  /** Whatever Steve typed. First line becomes the title; all of it goes in the body. */
  text: string;
  surface: TicketSurface;
  /** Open a Refine session on the new ticket ("grill me first"). */
  refine?: boolean;
  /** P0–P5 (PD-836). Omit or `null` to file unprioritized. The triage-inbox Epic is unclassified,
   *  so under D-080 the member keeps this value rather than inheriting one. */
  priority?: TicketPriority | null;
}

/** Partial update — any subset of these fields. */
export interface UpdateTicketInput {
  title?: string;
  body?: string | null;
  status?: TicketStatus;
  /** P0–P5, or `null` to unset. Omit to leave unchanged. */
  priority?: TicketPriority | null;
  sortOrder?: number;
  projectId?: number;
  /** 'steve' | 'robot', or `null` to unassign. Omit to leave unchanged. */
  assignee?: TicketAssignee | null;
  /** Link (or unlink, via `null`) a GitHub issue. Set together. Omit to leave unchanged. */
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  /** Mark the ticket refined (D-044, PD-268). Omit to leave unchanged. */
  refined?: boolean;
  /** Set when a human queued a not-Ready robot ticket via the confirm modal (D-058, PD-399);
   *  defaults false. Omit to leave unchanged. `ready` is NOT client-settable (server-computed
   *  from the body), so it is deliberately absent here. */
  readyBypassed?: boolean;
  /** Flag/unflag as an Epic (D-054). Omit to leave unchanged. */
  isEpic?: boolean;
  /** Set (via id) or clear (via null) the parent Epic. Omit to leave unchanged. */
  epicId?: number | null;
  /** Set (a number) or clear (null) the per-ticket run ceiling (PD-432). Omit to leave unchanged. */
  maxTurns?: number | null;
  /** D-103 (PD-808): exclude/include this Epic from auto-queue. Meaningful on Epics. Omit to leave
   *  unchanged. */
  autoQueueExcluded?: boolean;
}

/** An Epic's board lane (D-054, PD-336; D-080 drops `prioritized`).
 *
 *  **D-080 reverses the direction of travel for the pending lanes.** An Epic no longer *derives*
 *  its way into the queue: `backlog` ↔ `in_progress` is now a hand-set move on the Epic, and its
 *  members follow. Progress remains derived — `completed`/`closed` are observations of what the
 *  members actually did, which no top-down push may overwrite. */
export type EpicDerivedLane = 'backlog' | 'in_progress' | 'completed' | 'closed';

/** Per-Epic roll-up the board reads to place the Epic card + show `done/total` (D-054, PD-336).
 *  Fetched in bulk alongside tickets, like relations. */
export interface EpicSummary {
  ticketId: number;
  /** Members that are `completed` or `closed`. */
  done: number;
  /** Total member count. */
  total: number;
  /** Derived lane per D-054; for an empty Epic, derived from the Epic's own hand-set status. */
  derivedLane: EpicDerivedLane;
}

/**
 * The four section headers the `/to-robot-issues` Refine flow produces.
 * `## Done When` also accepts a `(acceptance checklist)` suffix.
 * All matched case-insensitively, tolerant of trailing text on the heading line.
 */
const REQUIRED_HEADERS = [
  /^## context/im,
  /^## task/im,
  /^## done when/im,
  /^## out of scope/im,
] as const;

/**
 * Returns true iff `body` contains all four Ready section headers (D-058: `ready`). The standard
 * hand-off shape a ticket's body must carry. Recomputed on every body write and persisted as the
 * `ready` column; the robot loop's hard dispatch gate reads that persisted flag (renamed from the
 * former `isRobotReady`; the check itself is unchanged — only the name + persist-on-write changed).
 */
export function isReady(body: string | null): boolean {
  if (!body) return false;
  return REQUIRED_HEADERS.every((re) => re.test(body));
}

// ── Queue gate (D-091, PD-632) ───────────────────────────────────────────────
// A robot-assigned ticket may not enter the Queue unless it and its Epic are refined. One pure
// predicate answers "may this be queued?" for every door that queues work — the PATCH guard, the
// Epic cascade, Approve & queue, the resume paths — and for the board's refusal modal (PD-633),
// so the client renders the server's answer instead of re-deriving it.

export type QueueCriterionId =
  'refined' | 'epic-refined' | 'epic-not-stale' | 'members-refined' | 'ready' | 'unblocked';

/** Where an unmet criterion is satisfied. `ticketId` is the ticket to open. */
export type QueueRemedyKind =
  'mark-refined' | 'refine-epic' | 'open-epic' | 'edit-body' | 'resolve-blocker';

export interface QueueCriterion {
  id: QueueCriterionId;
  label: string;
  met: boolean;
  /** An unmet bypassable criterion can be acknowledged and queued anyway (only `ready`, D-058). */
  bypassable: boolean;
  /**
   * Whether an unmet criterion refuses Queue *entry*. False for `ready` (bypassable, and the server
   * has never refused on it) and for `unblocked`, which D-051 as amended by PD-408 enforces at
   * dispatch time instead — a blocked ticket may sit in the Queue and the loop skips it.
   */
  refusesEntry: boolean;
  remedy: { kind: QueueRemedyKind; ticketId?: number };
}

type GateTicket = Pick<AgentTicket, 'id' | 'refined' | 'ready' | 'readyBypassed'>;
type GateEpic = Pick<AgentTicket, 'id' | 'refined' | 'refineStale'>;
type GateMember = Pick<AgentTicket, 'id' | 'refined' | 'status'>;

/**
 * The Epic-level criteria — identical for every member of one Epic, so the Epic cascade evaluates
 * them once. `members-refined` is **derived** here and never stored: D-089's three Epic states stand
 * unchanged. Terminal members are excluded (finished work needs no read-through), and so is
 * `exceptId` — the ticket being queued, which its own `refined` criterion already reports.
 */
export function epicQueueCriteria(
  epic: GateEpic | null,
  members: readonly GateMember[],
  exceptId?: number,
): QueueCriterion[] {
  if (!epic) {
    return [
      {
        id: 'epic-refined',
        label: 'No Epic',
        met: true,
        bypassable: false,
        refusesEntry: true,
        remedy: { kind: 'open-epic' },
      },
      {
        id: 'epic-not-stale',
        label: 'No Epic',
        met: true,
        bypassable: false,
        refusesEntry: true,
        remedy: { kind: 'open-epic' },
      },
      {
        id: 'members-refined',
        label: 'No Epic',
        met: true,
        bypassable: false,
        refusesEntry: true,
        remedy: { kind: 'open-epic' },
      },
    ];
  }
  const unrefined = members.filter(
    (m) => m.id !== exceptId && !m.refined && m.status !== 'completed' && m.status !== 'closed',
  );
  return [
    {
      id: 'epic-refined',
      label: epic.refined ? 'Its Epic is refined' : 'Its Epic is not refined',
      met: epic.refined,
      bypassable: false,
      refusesEntry: true,
      remedy: { kind: 'mark-refined', ticketId: epic.id },
    },
    {
      id: 'epic-not-stale',
      label: epic.refineStale
        ? "Its Epic's member set changed since it was refined — re-refine it"
        : "Its Epic's refinement is current",
      met: !epic.refineStale,
      bypassable: false,
      refusesEntry: true,
      remedy: { kind: 'refine-epic', ticketId: epic.id },
    },
    {
      id: 'members-refined',
      label:
        unrefined.length === 0
          ? 'Every open member of its Epic is refined'
          : `${unrefined.length} open member${unrefined.length === 1 ? '' : 's'} of its Epic ${unrefined.length === 1 ? 'is' : 'are'} not refined`,
      met: unrefined.length === 0,
      bypassable: false,
      refusesEntry: true,
      remedy: { kind: 'open-epic', ticketId: epic.id },
    },
  ];
}

/**
 * Every criterion for a robot-assigned ticket entering the Queue, in display order. Pass the
 * ticket as it WOULD be after the write (so `PATCH { status: 'queue', refined: true }` is judged on
 * the refined value), its Epic or `null`, the Epic's live members, and the ids of open `blocks`
 * blockers.
 */
export function queueBlockers(input: {
  ticket: GateTicket;
  epic: GateEpic | null;
  members: readonly GateMember[];
  openBlockerIds: readonly number[];
}): QueueCriterion[] {
  const { ticket, epic, members, openBlockerIds } = input;
  const [epicRefined, epicNotStale, membersRefined] = epicQueueCriteria(epic, members, ticket.id);
  return [
    {
      id: 'refined',
      label: ticket.refined ? 'This ticket is refined' : 'This ticket is not refined',
      met: ticket.refined,
      bypassable: false,
      refusesEntry: true,
      remedy: { kind: 'mark-refined', ticketId: ticket.id },
    },
    epicRefined,
    epicNotStale,
    membersRefined,
    {
      id: 'ready',
      label: ticket.ready
        ? 'The body has all four Ready sections'
        : ticket.readyBypassed
          ? 'The body is not Ready — bypassed'
          : 'The body is missing a Ready section',
      met: ticket.ready || ticket.readyBypassed,
      bypassable: true,
      refusesEntry: false,
      remedy: { kind: 'edit-body', ticketId: ticket.id },
    },
    {
      id: 'unblocked',
      label:
        openBlockerIds.length === 0
          ? 'Nothing blocks it'
          : `Blocked by ${openBlockerIds.length} open ticket${openBlockerIds.length === 1 ? '' : 's'} — it can wait in the Queue, but will not dispatch`,
      met: openBlockerIds.length === 0,
      bypassable: false,
      refusesEntry: false,
      remedy: { kind: 'resolve-blocker', ticketId: openBlockerIds[0] },
    },
  ];
}

/** The criteria that refuse Queue entry right now — empty means the write may proceed. */
export function queueEntryRefusals(criteria: readonly QueueCriterion[]): QueueCriterion[] {
  return criteria.filter((c) => !c.met && c.refusesEntry);
}

// ── Auto-queue eligibility (D-103, PD-808) ───────────────────────────────────
// One pure answer to "would the promoter queue this ticket, and if not, why?" — built ON TOP of
// `queueBlockers` so the promoter, the detail-page checklist and the board's Eligible view can
// never disagree with the hard Queue gate (D-091). Eligibility is COMPUTED, never stored (D-103 §3):
// there is no "Queue-eligible" lane, because any of a body edit (D-097), a new blocker, an Epic
// going stale (D-089) or a sibling un-refining would silently invalidate a stored flag.
//
// The promoter only ever carries out a decision a HUMAN already made — it moves members of an
// *active* (queued) Epic as they become eligible, and it never sets `assignee`, `ready_bypassed` or
// `refined` (D-103 §1). So "nothing but a human sets `refined = 1`" holds (verified PD-808: the only
// writers are ✓ Mark refined, a `PATCH { refined: true }`, and Steve approving a Refine proposal —
// no extra criterion needed to exclude a machine writer).

/** The per-ticket auto-queue criteria, in the order Steve reads them (D-103 §3). */
export type AutoQueueCriterionId =
  | 'refined'
  | 'epic-refined'
  | 'epic-not-stale'
  | 'members-refined'
  | 'epic-active'
  | 'assigned-robot'
  | 'ready'
  | 'unblocked'
  | 'refine-settled'
  | 'epic-not-excluded'
  | 'robot-project';

/** A single resolved criterion: the static `label`/`description` (from `AUTO_QUEUE_CRITERIA`) plus
 *  whether it is `met`, and a one-line `reason` when it is not. */
export interface AutoQueueCriterion {
  id: AutoQueueCriterionId;
  label: string;
  description: string;
  met: boolean;
  /** Present only when `met` is false — why this criterion fails right now. */
  reason?: string;
  /** Present only when `met` is false and the criterion has a structured fix — carried from the
   *  Queue gate (`queueBlockers`) so the checklist can link the reason to the Epic or the blocker
   *  (D-103, PD-809). `ticketId` is the ticket to open. */
  remedy?: { kind: QueueRemedyKind; ticketId?: number };
}

/**
 * The five outcomes the promoter + the UI distinguish:
 *  - `human-work`: assignee is `steve` or null — never auto-queued, whatever the criteria say.
 *  - `terminal`: the ticket is completed/closed — nothing to queue.
 *  - `in-queue`: already in the Queue lane.
 *  - `eligible`: every per-ticket criterion is met; the promoter would queue it (capacity permitting).
 *  - `not-eligible`: a robot ticket that is not yet eligible; the criteria say why.
 */
export type AutoQueueVerdict = 'eligible' | 'not-eligible' | 'in-queue' | 'terminal' | 'human-work';

export interface AutoQueueEligibility {
  verdict: AutoQueueVerdict;
  criteria: AutoQueueCriterion[];
}

/** Static definition (id + label + description) of each per-ticket criterion. Exported so the
 *  board's criteria modal and the detail-page checklist render from the SAME source the predicate
 *  judges against (D-103 §consequences). Order matches `AutoQueueCriterionId`. */
export const AUTO_QUEUE_CRITERIA: readonly {
  id: AutoQueueCriterionId;
  label: string;
  description: string;
}[] = [
  { id: 'refined', label: 'Refined', description: 'The ticket is refined — a human has read and attested the work.' },
  { id: 'epic-refined', label: 'Epic refined', description: "The ticket's Epic is refined." },
  { id: 'epic-not-stale', label: 'Epic current', description: "The Epic's refinement is current — its membership has not changed since." },
  { id: 'members-refined', label: 'Members refined', description: 'Every open member of the Epic is refined.' },
  { id: 'epic-active', label: 'Epic active', description: 'The Epic is in the Queue lane — Steve has activated it.' },
  { id: 'assigned-robot', label: 'Assigned to Robot', description: 'The ticket is assigned to the Robot.' },
  { id: 'ready', label: 'Ready', description: 'The body has the four Ready sections, or Steve set a bypass.' },
  { id: 'unblocked', label: 'Unblocked', description: 'No open ticket blocks it.' },
  { id: 'refine-settled', label: 'Refine settled', description: 'No Refine session is waiting on Steve.' },
  { id: 'epic-not-excluded', label: 'Epic not excluded', description: 'The Epic is not excluded from auto-queue.' },
  { id: 'robot-project', label: 'Robot project', description: 'The project is robot-enabled and has a GitHub repo.' },
] as const;

const AUTO_QUEUE_CRITERION_BY_ID = new Map(AUTO_QUEUE_CRITERIA.map((d) => [d.id, d] as const));

function autoQueueCriterion(
  id: AutoQueueCriterionId,
  met: boolean,
  reason: string,
  remedy?: { kind: QueueRemedyKind; ticketId?: number },
): AutoQueueCriterion {
  const def = AUTO_QUEUE_CRITERION_BY_ID.get(id)!;
  return {
    id,
    label: def.label,
    description: def.description,
    met,
    ...(met ? {} : { reason }),
    ...(met || !remedy ? {} : { remedy }),
  };
}

/** A ticket as the eligibility predicate reads it. */
type EligTicket = Pick<
  AgentTicket,
  'id' | 'status' | 'assignee' | 'refined' | 'ready' | 'readyBypassed' | 'refineState' | 'isEpic'
>;
/** The ticket's Epic (or null), plus the two columns the gate does not already read. */
type EligEpic = GateEpic & { status: TicketStatus; autoQueueExcluded: boolean };
/** The ticket's project — robot-enabled with a repo is what `robotQueueCandidates` requires. */
type EligProject = { robotEnabled: boolean; githubRepo: string | null } | null;

/**
 * Would the promoter auto-queue this (member) ticket, and if not, why? Pure and DB-free (D-103 §3).
 *
 * Reuses `queueBlockers` for criteria 1–4, 7 (`ready`) and 8 (`unblocked`) rather than re-deriving
 * them, so the hard Queue gate and auto-queue can never diverge. The five extra criteria
 * (`epic-active`, `assigned-robot`, `refine-settled`, `epic-not-excluded`, `robot-project`) are the
 * ones D-103 adds beyond D-091.
 *
 * `unblocked` is REQUIRED here even though D-091 lets a blocked ticket sit in the Queue: promoting a
 * blocked ticket only adds clutter (D-103 §3).
 */
export function autoQueueEligibility(input: {
  ticket: EligTicket;
  epic: EligEpic | null;
  members: readonly GateMember[];
  openBlockerIds: readonly number[];
  project: EligProject;
}): AutoQueueEligibility {
  const { ticket, epic, members, openBlockerIds, project } = input;

  const gate = queueBlockers({
    ticket: { id: ticket.id, refined: ticket.refined, ready: ticket.ready, readyBypassed: ticket.readyBypassed },
    epic: epic ? { id: epic.id, refined: epic.refined, refineStale: epic.refineStale } : null,
    members,
    openBlockerIds,
  });
  const gateById = new Map(gate.map((c) => [c.id, c] as const));
  // Map a reused `QueueCriterion` into an `AutoQueueCriterion`, carrying its dynamic label as the
  // reason when it is unmet (the gate's labels are already the "why", e.g. "This ticket is not
  // refined").
  const fromGate = (id: AutoQueueCriterionId & QueueCriterionId): AutoQueueCriterion => {
    const g = gateById.get(id)!;
    return autoQueueCriterion(id, g.met, g.label, g.remedy);
  };

  const epicActive = epic != null && epic.status === 'queue';
  const assignedRobot = ticket.assignee === 'robot';
  const refineSettled = ticket.refineState !== 'awaiting-human';
  const epicNotExcluded = !epic?.autoQueueExcluded;
  const robotProject = project != null && project.robotEnabled && project.githubRepo != null;

  const criteria: AutoQueueCriterion[] = [
    fromGate('refined'),
    fromGate('epic-refined'),
    fromGate('epic-not-stale'),
    fromGate('members-refined'),
    autoQueueCriterion(
      'epic-active',
      epicActive,
      epic ? 'Its Epic is not active — Steve has not queued it.' : 'It has no Epic to activate.',
      epic ? { kind: 'open-epic', ticketId: epic.id } : undefined,
    ),
    autoQueueCriterion('assigned-robot', assignedRobot, 'It is not assigned to the Robot.'),
    fromGate('ready'),
    fromGate('unblocked'),
    autoQueueCriterion('refine-settled', refineSettled, 'A Refine session is waiting on you.'),
    autoQueueCriterion(
      'epic-not-excluded',
      epicNotExcluded,
      'Its Epic is excluded from auto-queue.',
      epic ? { kind: 'open-epic', ticketId: epic.id } : undefined,
    ),
    autoQueueCriterion(
      'robot-project',
      robotProject,
      'The project is not robot-enabled or has no GitHub repo.',
    ),
  ];

  const verdict: AutoQueueVerdict =
    ticket.status === 'completed' || ticket.status === 'closed'
      ? 'terminal'
      : ticket.assignee !== 'robot'
        ? 'human-work'
        : ticket.status === 'queue'
          ? 'in-queue'
          : criteria.every((c) => c.met)
            ? 'eligible'
            : 'not-eligible';

  return { verdict, criteria };
}

// ── Auto-queue: the Epic variant ─────────────────────────────────────────────

/** The Epic-level criteria the Epic detail page shows (D-103 §3), a subset of the per-ticket ids. */
export type AutoQueueEpicCriterionId =
  | 'epic-refined'
  | 'epic-not-stale'
  | 'members-refined'
  | 'epic-active'
  | 'epic-not-excluded';

/** Roll-up of one member's verdict, for the Epic detail page. */
export interface AutoQueueMemberVerdict {
  ticketId: number;
  verdict: AutoQueueVerdict;
}

export interface AutoQueueEpicEligibility {
  criteria: AutoQueueCriterion[];
  /** Per-member verdict roll-up, in the members' board order. */
  members: AutoQueueMemberVerdict[];
}

/**
 * The Epic-level criteria plus a per-member verdict roll-up (D-103 §3). Pure and DB-free: the caller
 * supplies the Epic's members and each member's open-blocker ids. `members-refined` is derived from
 * the member set (never stored), reusing `epicQueueCriteria`.
 */
export function autoQueueEpicEligibility(input: {
  epic: EligEpic;
  members: readonly EligTicket[];
  project: EligProject;
  /** Open `blocks` blocker ids per member id; absent ⇒ unblocked. */
  openBlockerIdsByMember?: Readonly<Record<number, readonly number[]>>;
}): AutoQueueEpicEligibility {
  const { epic, members, project, openBlockerIdsByMember } = input;

  // `members-refined` is the one Epic-level criterion derived from the whole set (D-089). Reuse the
  // gate's derivation so it cannot drift; terminal members are excluded there.
  const gateMembers: GateMember[] = members.map((m) => ({ id: m.id, refined: m.refined, status: m.status }));
  const [, , membersRefined] = epicQueueCriteria(
    { id: epic.id, refined: epic.refined, refineStale: epic.refineStale },
    gateMembers,
  );

  // Every Epic-level criterion is fixed on the Epic itself; its remedy points back here so the
  // board's criteria modal can link to the Epic (the detail page suppresses the self-link).
  const self = { kind: 'open-epic' as const, ticketId: epic.id };
  const criteria: AutoQueueCriterion[] = [
    autoQueueCriterion('epic-refined', epic.refined, 'This Epic is not refined.', self),
    autoQueueCriterion('epic-not-stale', !epic.refineStale, "This Epic's membership changed since it was refined — re-refine it.", self),
    autoQueueCriterion('members-refined', membersRefined.met, membersRefined.label, self),
    autoQueueCriterion('epic-active', epic.status === 'queue', 'This Epic is not active — queue it to activate its members.', self),
    autoQueueCriterion('epic-not-excluded', !epic.autoQueueExcluded, 'This Epic is excluded from auto-queue.', self),
  ];

  const memberVerdicts: AutoQueueMemberVerdict[] = members.map((m) => ({
    ticketId: m.id,
    verdict: autoQueueEligibility({
      ticket: m,
      epic,
      members: gateMembers,
      openBlockerIds: openBlockerIdsByMember?.[m.id] ?? [],
      project,
    }).verdict,
  }));

  return { criteria, members: memberVerdicts };
}

// ── Auto-queue: capacity (board/worker-wide, D-103 §4) ───────────────────────
// Capacity is evaluated server-side each promoter tick, not per-ticket. Promotion stops at
// whichever limit is hit first. The limits that depend on worker config (`ROBOT_CONCURRENCY`) are
// read from `robot_state`, the same channel the budget policy uses (D-103 §4) — the web process
// cannot see the worker's env.

export type AutoQueueCapacityId = 'queue-depth' | 'review-wip' | 'epic-in-flight' | 'worker-healthy';

/** One capacity limb: `current` against `limit`. `met` is `current < limit` for the count limbs;
 *  `worker-healthy` is a composite whose `reason` names the failing condition. */
export interface AutoQueueCapacityRow {
  id: AutoQueueCapacityId;
  label: string;
  description: string;
  current: number;
  limit: number;
  met: boolean;
  /** Present when `met` is false — what is at capacity / unhealthy. */
  reason?: string;
}

export interface AutoQueueCapacity {
  rows: AutoQueueCapacityRow[];
  /** True when every limb has headroom — the promoter may promote this tick. */
  ok: boolean;
}

/** Robot tickets `in-review` (incl. PRs held by the review/visual gate or conflicting) may not
 *  exceed this before the promoter stops (D-103 §4). */
export const AUTO_QUEUE_REVIEW_WIP_LIMIT = 3;
/** At most this many of an Epic's members may be in flight (queued-not-dispatched / working /
 *  in-review) before the promoter stops promoting that Epic (D-103 §4). */
export const AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT = 1;
/** The multiple of `ROBOT_CONCURRENCY` the dispatchable-in-Queue depth may reach (D-103 §4). */
export const AUTO_QUEUE_QUEUE_DEPTH_FACTOR = 2;
/** A worker heartbeat older than this is stale, so the loop's health cannot be confirmed. Matches
 *  the board's Site Status staleness window. */
export const AGENT_WORKER_HEARTBEAT_STALE_MS = 90_000;
/** The `robot_state` key the worker publishes its effective capacity policy under (concurrency),
 *  mirroring `budget_policy` — the web process cannot read `ROBOT_CONCURRENCY` directly. */
export const ROBOT_CAPACITY_POLICY_KEY = 'capacity_policy';
/** Fallback concurrency when the worker has not published a policy yet (matches the env default). */
export const ROBOT_CONCURRENCY_DEFAULT = 1;

/** Static definition (id + label + description) of each board/worker-wide capacity limb. Exported so
 *  `computeAutoQueueCapacity` (the live rows), the detail-page checklist and the board's criteria
 *  modal render from ONE source — the same single-source pattern as `AUTO_QUEUE_CRITERIA` (D-103
 *  §consequences, PD-810). Order matches `AutoQueueCapacityId`. The descriptions embed the limit
 *  constants above so they can never contradict the numbers the predicate enforces. */
export const AUTO_QUEUE_CAPACITY_DEFS: readonly {
  id: AutoQueueCapacityId;
  label: string;
  description: string;
}[] = [
  {
    id: 'queue-depth',
    label: 'Queue depth',
    description: `Dispatchable robot tickets in the Queue stay below ROBOT_CONCURRENCY × ${AUTO_QUEUE_QUEUE_DEPTH_FACTOR}.`,
  },
  {
    id: 'review-wip',
    label: 'Review WIP',
    description: `Robot tickets awaiting review stay below ${AUTO_QUEUE_REVIEW_WIP_LIMIT}.`,
  },
  {
    id: 'epic-in-flight',
    label: 'Epic in flight',
    description: `At most ${AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT} member of this Epic is in flight at once.`,
  },
  {
    id: 'worker-healthy',
    label: 'Worker healthy',
    description: 'Dispatch is not paused or held, the budget has headroom, and the worker is alive.',
  },
] as const;

// ── Auto-queue: mode + verdict wording (D-103 §4, PD-809) ────────────────────
// The promoter ships behind `AUTO_QUEUE=off|dry-run|on` (D-103 §4). The checklist surfaces the mode
// so Steve can tell, on any ticket, whether the ✓/✗ he is reading actually drives anything yet, and
// renders a single verdict line from the same pure taxonomy the predicate produces.

/** The promoter's run mode (D-103 §4): `off` promotes nothing, `dry-run` logs without applying,
 *  `on` promotes. Defaults to `off`. */
export type AutoQueueMode = 'off' | 'dry-run' | 'on';

/** Parse the `AUTO_QUEUE` env value into a mode, defaulting to `off` for anything unrecognised. */
export function parseAutoQueueMode(raw: string | null | undefined): AutoQueueMode {
  return raw === 'on' || raw === 'dry-run' ? raw : 'off';
}

/** The muted note shown under the verdict while the promoter is not live; `null` when `on`. */
export function autoQueueModeNote(mode: AutoQueueMode): string | null {
  if (mode === 'off') return 'Auto-queue is off — nothing is promoted automatically.';
  if (mode === 'dry-run') return 'Auto-queue is in dry-run — promotions are logged, not applied.';
  return null;
}

/** The one-line verdict shown above a member Ticket's criteria (D-103 §consequences). `assignee`
 *  splits the two `human-work` cases; `unmetCount` fills the `not-eligible` count. */
export function autoQueueVerdictLine(
  verdict: AutoQueueVerdict,
  assignee: TicketAssignee | null,
  unmetCount: number,
): string {
  switch (verdict) {
    case 'eligible':
      return 'Will auto-queue when capacity allows';
    case 'in-queue':
      return 'In the Queue';
    case 'terminal':
      return 'Completed/Closed — not applicable';
    case 'human-work':
      return assignee === 'steve'
        ? 'Not auto-queued — assigned to steve (human work is never automated)'
        : 'Not auto-queued — no assignee';
    case 'not-eligible':
      return `Not eligible — ${unmetCount} unmet`;
  }
}

/** Short word for a member's verdict, for the Epic roll-up list (D-103). */
export const AUTO_QUEUE_VERDICT_SHORT: Record<AutoQueueVerdict, string> = {
  eligible: 'eligible',
  'not-eligible': 'not eligible',
  'in-queue': 'in queue',
  terminal: 'done',
  'human-work': 'human',
};

/** The verdict line for an Epic: it is never dispatched itself, so the line is about whether its
 *  members *can* auto-queue (D-103 §3). Unmet Epic-level criteria block every member. */
export function autoQueueEpicVerdictLine(eligibility: AutoQueueEpicEligibility): string {
  const unmet = eligibility.criteria.filter((c) => !c.met).length;
  return unmet > 0 ? `Not eligible — ${unmet} unmet` : 'Members auto-queue as they become eligible';
}

/** `N of M members eligible`, the Epic member roll-up tally (D-103 §3). */
export function autoQueueMemberRollup(members: readonly AutoQueueMemberVerdict[]): {
  eligible: number;
  total: number;
} {
  return { eligible: members.filter((m) => m.verdict === 'eligible').length, total: members.length };
}

/**
 * What `GET …/tickets/:id/queue-eligibility` returns (D-103, PD-808). A member carries
 * `eligibility`; an Epic carries `epicEligibility` (its own criteria + a per-member verdict
 * roll-up). Both carry the board/worker-wide `capacity` snapshot the promoter evaluates each tick,
 * and the promoter's `mode` so the UI can say whether any of it is live yet (D-103 §4).
 */
export interface AutoQueueEligibilityResponse {
  ticketId: number;
  isEpic: boolean;
  /** Present for a member Ticket. */
  eligibility?: AutoQueueEligibility;
  /** Present for an Epic. */
  epicEligibility?: AutoQueueEpicEligibility;
  capacity: AutoQueueCapacity;
  /** The promoter's run mode (`AUTO_QUEUE`), so the checklist can flag off/dry-run (D-103 §4). */
  mode: AutoQueueMode;
}

/**
 * What `GET …/queue-eligibility` returns (D-103, PD-808): every live Backlog ticket's eligibility in
 * one read, for the board's Eligible view. `capacity` is the board-wide snapshot (its `epic-in-flight`
 * limb is evaluated with no Epic in view); `epicInFlight` gives each Epic's own in-flight count to
 * judge that limb per card against `AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT`.
 */
export interface AutoQueueBoardEligibility {
  capacity: AutoQueueCapacity;
  epicInFlight: Record<number, number>;
  tickets: Record<number, AutoQueueEligibility>;
}

// ── Auto-queue: the promoter's audit trail + tick summary (D-103 §4, PD-811) ──
// The server-side promoter runs on an interval and moves eligible Backlog members of active Epics
// into the Queue through the SAME store path + guard the PATCH route uses. Every promotion is an
// `agent_ticket_events` row carrying the criteria + capacity snapshot that justified it, so the
// decision is auditable after the fact; dry-run records the same thing without the status write.

/** `agent_ticket_events.type` values the auto-queue promoter emits (PD-811). Referenced by BOTH the
 *  server (write + the card's auto-queued-badge subselect) and potential readers, so the literals
 *  live here (mirrors ROBOT_EVENT / REFINE_EVENT_TYPE). */
export const AUTO_QUEUE_EVENT = {
  /** A promotion actually applied (mode `on`). */
  queued: 'auto_queued',
  /** A promotion that WOULD have applied (mode `dry-run`) — logged, never written to status. */
  dryRun: 'auto_queue_dry_run',
  /** The Queue guard refused a promotion the eligibility predicate judged eligible — logged, not
   *  thrown (D-103 §consequences: "a refusal from the existing guard is logged, not bypassed"). */
  refused: 'auto_queue_refused',
} as const;

/** The JSON `detail` stored on an `auto_queued` / `auto_queue_dry_run` event — the full justification
 *  for the promotion, so the decision can be read back off the activity log (D-103 §4). */
export interface AutoQueuePromotionDetail {
  mode: AutoQueueMode;
  epicId: number | null;
  /** The per-ticket eligibility criteria (all met for a promotion). */
  criteria: AutoQueueCriterion[];
  /** The capacity snapshot at the moment of promotion. */
  capacity: AutoQueueCapacityRow[];
}

/** One ticket the promoter moved (or would have moved) this tick. */
export interface AutoQueuePromotedItem {
  ticketId: number;
  displayId: string;
  epicId: number | null;
}

/**
 * The summary of one promoter tick, published to `robot_state` under `AUTO_QUEUE_LAST_TICK_KEY` so
 * Dev Ops / the eligibility checklist can show "last tick promoted X" or "would have queued X
 * because …" without the promoter being `on` (D-103 §4).
 */
export interface AutoQueueTickSummary {
  mode: AutoQueueMode;
  /** Unix ms the tick ran. */
  ranAt: number;
  /** Tickets actually moved into the Queue (always empty in `off`/`dry-run`). */
  promoted: AutoQueuePromotedItem[];
  /** Tickets the promoter WOULD have queued (populated in `dry-run`; empty in `on`/`off`). */
  wouldPromote: AutoQueuePromotedItem[];
  /** How many eligible candidates were considered before a capacity limit (if any) halted the tick. */
  considered: number;
  /** The board-wide capacity limb that halted the tick, or null if it ran to the end of the Backlog. */
  stoppedBy: AutoQueueCapacityId | null;
  /** False when the worker was too unhealthy to promote at all this tick. */
  workerHealthy: boolean;
  /** Why the worker was unhealthy, when it was (the `worker-healthy` composite reason). */
  unhealthyReason?: string;
}

/** The `robot_state` key the server's promoter writes its last-tick summary to (D-103 §4). Unlike
 *  most `robot_state` keys this one is SERVER-written (the promoter runs in the web process); the
 *  worker never touches it. */
export const AUTO_QUEUE_LAST_TICK_KEY = 'auto_queue_last_tick';

// ── Notification Center (D-040) ──────────────────────────────────────────────
// A notification surfaced in the dashboard's in-app inbox. MVP kinds cover an agent
// parking for a human (ask_human / needs-human); widget notifications plug in later.
// 'agent_refine' (D-044, PD-267): the Refine/agent-worker agent posted a turn (plan, questions,
// or needs-full-refine) on a ticket's Refine thread and wants Steve's attention.
/** `agent_auto_merged` (PD-765): the merge bridge merged a Robot PR with no human approval, on the
 *  strength of its required checks and the `review-gate` status (D-098). Informational, not a call
 *  to act. */
/** `agent_visual_review` (PD-773): a PR is held for Steve's visual check. Links to Decisions. */
/** `agent_auto_queued` (D-103, PD-811): the auto-queue promoter moved one or more Backlog tickets
 *  into the Queue this tick. A non-ticket-scoped digest — ONE per tick that promoted anything, not
 *  one per ticket. */
export type NotificationKind = 'agent_awaiting_human' | 'agent_needs_human' | 'agent_refine' | 'agent_auto_merged' | 'agent_visual_review' | 'agent_auto_queued';

/** A Robot PR waiting for Steve's visual check (PD-773 slice 2), for the Decisions inbox. */
/** One screenshot of a visual capture. `step` (PD-798) is the click it was taken after, e.g.
 *  `click "Add metric"`; absent for the page as it first loaded. */
export interface VisualShot {
  route: string;
  viewport: string;
  scheme: string;
  file: string;
  url: string;
  step?: string;
  stepIndex?: number;
}

/** A click step that could not run during a capture (PD-798). */
export interface VisualStepFailure {
  route: string;
  step: string;
  reason: string;
}

export interface AwaitingVisualItem {
  ticketId: number;
  displayId: string | null;
  title: string;
  prNumber: number;
  prUrl: string | null;
  /** Who asked, and what to look at. */
  reasons: { by: 'robot' | 'evaluator'; reason: string }[];
  /** The newest capture of this PR; empty until the capture job has photographed it. */
  shots: VisualShot[];
  /** PD-798: click steps from the PR's `Visual:` line that could not run, with why. */
  stepFailures: VisualStepFailure[];
  capturedAt: number | null;
  requestedAt: number;
  /** PD-794: what actually happened with capture for the PR's current head. */
  capture: VisualCaptureState;
}

/**
 * The capture state of a PR's current head (PD-794), from its newest `visual_captures` row after the
 * review boundary and the worker's capture heartbeat:
 *  - `captured`: screenshots exist for this head.
 *  - `capturing`: capture is on and this head is still queued; `since` is when the head arrived.
 *  - `off`: `VISUAL_CAPTURE_ENABLED` is not set on the worker, so nothing is coming.
 *  - `failed`: the capture ran and failed; `reason` is why.
 *  - `skipped`: capture was not attempted for a recorded reason (e.g. no web changes).
 *  - `unknown`: the worker has not reported in recently, so whether capture is on is not known.
 */
export type VisualCaptureState =
  | { kind: 'captured' }
  | { kind: 'capturing'; since: number }
  | { kind: 'off' }
  | { kind: 'failed'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'unknown'; lastSeen: number | null };

/** The `robot_state` key the worker writes on every visual-job tick: '1' when capture is on, '0' off. */
export const VISUAL_CAPTURE_ENABLED_KEY = 'visual_capture_enabled';
/** Past this age the heartbeat is stale and the card says the capture state is unknown. */
export const VISUAL_CAPTURE_HEARTBEAT_STALE_MS = 10 * 60_000;
/** The env var that switches capture on, named in the UI and PR comments. */
export const VISUAL_CAPTURE_ENV = 'VISUAL_CAPTURE_ENABLED';

/** The title prefix of a visual-check notification, followed by "PR #N (PD-x)". */
export const VISUAL_REVIEW_NOTIFICATION_PREFIX = 'Visual check waiting:';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'agent_awaiting_human',
  'agent_needs_human',
  'agent_refine',
  'agent_auto_merged',
  'agent_visual_review',
  'agent_auto_queued',
] as const;

export interface AgentNotification {
  id: number;
  kind: NotificationKind;
  /** The ticket this notification is about, if any (null for non-ticket sources). */
  ticketId: number | null;
  /** Ticket display-id (e.g. 'PD-7') for linking/display; null when unresolved. */
  ticketDisplayId: string | null;
  title: string;
  /** Free-text detail — e.g. the agent's ask_human question. */
  body: string | null;
  /** Unix ms when marked read; null = unread. */
  readAt: number | null;
  createdAt: number;
}

/** The HTML-comment marker the Robot loop stamps on a human reply so the pr-state trust
 *  check can recognise a reply the board itself mirrored (reply-mirror ↔ pr-state, D-055).
 *  Produced and consumed entirely within our own code, so it stays internally consistent. */
export const HUMAN_REPLY_MARKER = '<!-- robot:human-reply -->';

// ── Ticket activity log + Refine thread (D-044, PD-267) ──────────────────────
// The `agent_ticket_events` table is the generic per-ticket activity log (created /
// status_changed / assignee_changed / archived / …). PD-267 adds two Refine event
// types that together form the persistent Refine conversation; PD-255 will render
// the rest of the log on the ticket-detail page over this same shape.

/** A row from the ticket activity log. Generic substrate — `detail` shape depends on
 *  `type` (the Refine subset uses `RefineDetail`). `GET /tickets/:id/events` returns these. */
export interface TicketEvent {
  id: number;
  ticketId: number;
  type: string;
  /** Parsed JSON detail, or null. */
  detail: unknown;
  createdAt: number;
}

/** Who authored a Refine turn. `human` = Steve (kickoff = the ticket body, then replies);
 *  `agent` = the agent-worker (Claude Agent SDK / Opus) — a plan, clarifying questions, or a
 *  needs-full-refine verdict. */
export type RefineRole = 'human' | 'agent';

/** The two `agent_ticket_events.type` values that carry the Refine thread. Referenced by
 *  BOTH the server (read endpoint + reply write) and the agent-worker (poll + post), so the
 *  string literals live here to keep the two processes in lockstep. */
export const REFINE_EVENT_TYPE: Record<RefineRole, string> = {
  human: 'refine_human',
  agent: 'refine_agent',
} as const;

/** JSON stored in a refine_* event's `detail`. Agent turns also persist the Claude Agent
 *  SDK `sessionId` so the agent-worker can `resume` the thread after a restart (rehydrated
 *  from the newest refine_agent event — no separate session table). */
export interface RefineDetail {
  text: string;
  /** Present only on refine_agent turns; the SDK session id to resume from. */
  sessionId?: string;
  /** PD-744: on a refine_agent turn, the structured question round the agent asked via
   *  `ask_questions`. Absent on free-text turns. */
  round?: RefineQuestionRound;
  /** PD-744: on a refine_human turn, the structured answers Steve sent; `text` holds their
   *  rendering, which is what the agent reads. */
  answers?: RefineAnswerSet;
}

/** A single Refine turn, projected from a refine_* `TicketEvent` for the thread UI. */
export interface RefineMessage {
  id: number;
  ticketId: number;
  role: RefineRole;
  text: string;
  createdAt: number;
  /** PD-744: the structured round on an agent turn, if it asked one. */
  round?: RefineQuestionRound;
  /** PD-744: the structured answers on a human turn, if it sent them. */
  answers?: RefineAnswerSet;
}

/** True for the two Refine event types. */
export function isRefineEventType(type: string): boolean {
  return type === REFINE_EVENT_TYPE.human || type === REFINE_EVENT_TYPE.agent;
}

/** Live Refine session state, for the card/detail pill (D-044, PD-268). Derived from the
 *  newest refine_* turn: `refining` = the agent is working / about to (Steve's turn is
 *  newest); `awaiting-human` = the agent replied and is waiting on Steve. (`done` arrives
 *  with the commit step, PD-269.) */
export type RefineState = 'refining' | 'awaiting-human';

/** Steve ended a Refine session without committing anything (PD-743, D-096). Written by
 *  `POST /tickets/:id/refine-park`; a later human reply reopens the session. */
export const REFINE_PARKED_EVENT = 'refine_parked';

/**
 * The event types that END a Refine session (PD-743, D-096): an approved commit, or a park.
 * `refine_rejected` is deliberately absent — rejecting a proposal leaves the session open so the
 * agent can propose again. A turn (human or agent) newer than one of these reopens the session.
 */
// 'refine_committed' is REFINE_PROPOSAL_EVENT.committed, spelled out because that constant is
// declared further down this module and would not be initialized yet here.
export const REFINE_SESSION_END_TYPES: readonly string[] = ['refine_committed', REFINE_PARKED_EVENT];

/** Every event type that decides a ticket's Refine state: the two turn types plus the ends. */
export const REFINE_STATE_EVENT_TYPES: readonly string[] = [
  REFINE_EVENT_TYPE.human,
  REFINE_EVENT_TYPE.agent,
  ...REFINE_SESSION_END_TYPES,
];

/** Map the newest Refine-state event type (one of `REFINE_STATE_EVENT_TYPES`) to a session
 *  state, or null if there is none or the session has ended (PD-743). Before PD-743 only the
 *  two turn types were considered, so a session that ended in an approved commit read as
 *  `awaiting-human` forever. */
export function refineStateFromLatestType(
  latestRefineType: string | null | undefined,
): RefineState | null {
  if (latestRefineType === REFINE_EVENT_TYPE.agent) return 'awaiting-human';
  if (latestRefineType === REFINE_EVENT_TYPE.human) return 'refining';
  return null;
}

/** How the newest Refine session ended, or null if it is still open (or never started). Pure,
 *  over a ticket's event log in any order — the thread UI uses it to show the ended notice. */
export function refineSessionEnd(
  events: readonly { type: string; createdAt: number; id: number }[],
): 'committed' | 'parked' | null {
  let newest: { type: string; createdAt: number; id: number } | null = null;
  for (const e of events) {
    if (!REFINE_STATE_EVENT_TYPES.includes(e.type)) continue;
    if (newest === null || e.createdAt > newest.createdAt || (e.createdAt === newest.createdAt && e.id > newest.id)) {
      newest = e;
    }
  }
  if (newest === null) return null;
  if (newest.type === REFINE_PARKED_EVENT) return 'parked';
  if (newest.type === 'refine_committed') return 'committed';
  return null;
}

// ── Ticket relations (D-020 table, first used by PD-269) ─────────────────────
// `blocks` (the table default, for the future blocked-by/blocking UI, PD-156), `split`
// (parent → child, written when a Refine decompose closes the parent into children, D-036),
// `relates` (a soft, non-blocking "see also" link) and `duplicates` (from-ticket duplicates
// to-ticket; the from side is typically archived). `relates`/`duplicates` are written
// structurally by the Ticket Audit's LINK / duplicate-archive findings (PD-288).
export type RelationType = 'blocks' | 'split' | 'relates' | 'duplicates';

export const RELATION_TYPES: readonly RelationType[] = [
  'blocks',
  'split',
  'relates',
  'duplicates',
] as const;

// Who authored a relation (D-048). `agent` = written by the refine decompose or the Ticket
// Audit (PD-288); `human` = hand-drawn in the relations UI (PD-322). The DB column defaults
// `'agent'` so pre-existing rows (all refine-authored splits) back-fill correctly with no
// data migration. Provenance is orthogonal to `type`: a `split` can be either origin.
export type RelationOrigin = 'agent' | 'human';

export interface TicketRelation {
  id: number;
  fromTicketId: number;
  toTicketId: number;
  type: RelationType;
  origin: RelationOrigin;
  createdAt: number;
}

/** One end of a split lineage, resolved for the read-only display on ticket-detail. */
export interface LineageRef {
  ticketId: number;
  displayId: string | null;
  title: string;
  status: TicketStatus;
}

/** A relation touching a ticket, resolved to the ticket on the other end. `direction: 'from'`
 *  means this ticket is `from_ticket_id` (the source — it blocks / splits into / duplicates the
 *  other); `'to'` means it is `to_ticket_id` (the target). Consumers that treat relations as
 *  truth (e.g. the Ticket Audit, PD-288) read these to avoid re-proposing existing links. */
export interface ResolvedRelation {
  id: number;
  type: RelationType;
  origin: RelationOrigin;
  direction: 'from' | 'to';
  other: LineageRef;
  createdAt: number;
}

/** A ticket's split lineage: what it was split into (as a parent) and what it was split
 *  from (as a child). Full relations management is PD-156; PD-269 renders this read-only. */
export interface TicketLineage {
  splitInto: LineageRef[];
  splitFrom: LineageRef[];
}

// ── Refine commit / decompose proposal (D-044, PD-269) ───────────────────────
// On approval the agent-worker commits. It never writes tickets directly — it PROPOSES via the
// `propose_commit` SDK tool, which writes a `refine_proposal` event; the server executes on
// Steve's approval (`refine_committed`) or drops it on reject (`refine_rejected`).

/** Lifecycle event types for a commit proposal (stored in agent_ticket_events). */
export const REFINE_PROPOSAL_EVENT = {
  proposal: 'refine_proposal',
  committed: 'refine_committed',
  rejected: 'refine_rejected',
} as const;

/**
 * Lifecycle events for the `refined` flag itself (PD-610 / PD-396).
 *
 * Nothing about `refined` was logged before — `updateTicket` logged only `status_changed` — so
 * there was no way to tell whether either invalidation mechanism was earning its keep. These make
 * the choices measurable, which is what lets "automate it if the same option is always chosen" be
 * a decision rather than a guess.
 */
export const REFINE_STATE_EVENT = {
  /** `refined` was cleared. `cause` says which rule fired. */
  invalidated: 'refine_invalidated',
  /** The body-edit prompt was DECLINED and `refined` left set (PD-396 only — the membership rule
   *  does not prompt, so it can never produce this). The ratio of these to
   *  `invalidated { cause: 'body' }` is the decline rate, and a near-zero rate is the signal that
   *  the prompt is asking a question with one real answer. */
  kept: 'refine_kept',
  /** ✓ Mark refined was clicked. `wasStale` separates a FIRST refinement from a re-assert after an
   *  automatic invalidation — without it the two are indistinguishable and the measurement is
   *  worthless, because a re-assert landing straight after an `invalidated` IS a false positive. */
  marked: 'refine_marked',
} as const;

export type RefineStateEventType = (typeof REFINE_STATE_EVENT)[keyof typeof REFINE_STATE_EVENT];

/** Why `refined` was cleared. `members` never prompts (the trigger is exact); `body` always does
 *  (a typo and a rewrite are indistinguishable) — one rule, two triggers that differ in kind. */
export type RefineInvalidationCause = 'members' | 'body';

export type RefineCommitMode = 'refine_in_place' | 'decompose';

/** A proposed child ticket in a decompose. Robot-bound children SHOULD be `isReady`-shaped
 *  (four sections, PD-177) so they are Ready the moment they're created (D-058). */
export interface RefineChildProposal {
  title: string;
  body: string;
  status: TicketStatus;
  assignee: TicketAssignee | null;
  /** PD-432: an estimated per-run turn ceiling, set ONLY when the agent has argued the work cannot
   *  decompose further. Omitted/null = the loop default, which is the expected case — decomposing
   *  stays the preferred move, and raising the cap is the escape hatch. */
  maxTurns?: number | null;
  /** PD-634: whether the child is born refined. Omitted = true — the Refine session IS the read-through.
   *  The agent sets false only for a placeholder that needs its own session. The server downgrades a
   *  robot-assigned child whose body fails `isReady`, so the flag never claims more than that check. */
  refined?: boolean;
}

/** The relation types a Refine proposal may carry between its children (PD-842). `split` stays
 *  automatic (parent→child lineage) and `duplicates` makes no sense between siblings being born. */
export type RefineRelationType = 'blocks' | 'relates';
export const REFINE_RELATION_TYPES: readonly RefineRelationType[] = ['blocks', 'relates'];

/** A proposed relation between two decompose children, addressed by 0-based index into
 *  `RefineProposal.children` — the children have no ids until approval creates them (PD-842). */
export interface RefineRelationProposal {
  from: number;
  to: number;
  type: RefineRelationType;
}

/**
 * Mechanical shape check for a proposal's `relations` (PD-842): index range, self-edges, and
 * `blocks` cycles among the children. Returns an instructive error, or null when well-formed.
 * Shared so the propose tool (immediate agent feedback) and the approve path (defence against a
 * stored proposal) apply the same rule.
 */
export function refineRelationsError(
  relations: readonly RefineRelationProposal[] | undefined,
  childCount: number,
): string | null {
  if (!relations || relations.length === 0) return null;
  const adj = new Map<number, number[]>();
  for (const r of relations) {
    const label = `relation ${r.from} → ${r.to}`;
    if (!REFINE_RELATION_TYPES.includes(r.type)) {
      return `${label} has type "${r.type}", but only ${REFINE_RELATION_TYPES.join(' / ')} may be proposed.`;
    }
    for (const end of [r.from, r.to]) {
      if (!Number.isInteger(end) || end < 0 || end >= childCount) {
        return `${label} points at child index ${end}, but there are only ${childCount} children (0-based, 0..${childCount - 1}).`;
      }
    }
    if (r.from === r.to) return `${label} relates a child to itself.`;
    if (r.type === 'blocks') adj.set(r.from, [...(adj.get(r.from) ?? []), r.to]);
  }
  // Cycle check over the `blocks` edges (D-048): a cycle would leave every member permanently blocked.
  const state = new Map<number, 1 | 2>(); // 1 = on stack, 2 = done
  const visit = (n: number, path: number[]): number[] | null => {
    if (state.get(n) === 1) return [...path, n];
    if (state.get(n) === 2) return null;
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      const cyc = visit(m, [...path, n]);
      if (cyc) return cyc;
    }
    state.set(n, 2);
    return null;
  };
  for (const n of adj.keys()) {
    const cyc = visit(n, []);
    if (cyc) return `the blocks relations form a cycle (${cyc.join(' → ')}), which would leave those children permanently blocked.`;
  }
  return null;
}

/**
 * The structured commit proposal, stored as the detail of a `refine_proposal` event.
 *
 * **There is no `priority` here, on the proposal or on a child (D-080, PD-510).** Priority is
 * an Epic property that the write path cascades to members, so a Ticket-level priority was being
 * accepted, stored, shown in the approval panel, and then silently overridden — the agent spent
 * turns choosing a value that never survived the write. Proposals persisted before PD-510 may still
 * carry the key in their stored JSON; it is simply not read. Absence from the type is the point:
 * every reader is a compile error rather than a field that quietly does nothing.
 */
export interface RefineProposal {
  mode: RefineCommitMode;
  /** refine_in_place: the rewritten body + routing for the SAME ticket. A decompose whose target is
   *  an Epic (Populate) REQUIRES it: the Epic's rewritten description (PD-634). */
  body?: string;
  status?: TicketStatus;
  assignee?: TicketAssignee | null;
  /** refine_in_place: an estimated turn ceiling for THIS ticket (PD-432); null clears it. */
  maxTurns?: number | null;
  /** decompose: the children to create; the parent is then closed + linked (split). */
  children?: RefineChildProposal[];
  /** decompose (PD-842): relations between the proposed children, by index into `children`.
   *  Written in the approval transaction, so a dependency chain arrives wired instead of needing
   *  Steve to link it by hand. Omitted on every proposal stored before PD-842. */
  relations?: RefineRelationProposal[];
  /** Short why, shown in the approval panel. */
  rationale?: string;
}

/**
 * The latest proposal still awaiting a decision, or null. "Actionable" = a `refine_proposal`
 * event with no `refine_committed`/`refine_rejected` event after it (a later proposal or a
 * decision supersedes it). Shared so the web panel and the server's approve path agree.
 */
export function latestActionableProposal(
  events: TicketEvent[],
): { eventId: number; proposal: RefineProposal } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === REFINE_PROPOSAL_EVENT.committed || e.type === REFINE_PROPOSAL_EVENT.rejected) {
      return null; // newest lifecycle event is a decision → nothing pending
    }
    if (e.type === REFINE_PROPOSAL_EVENT.proposal) {
      return { eventId: e.id, proposal: (e.detail ?? {}) as RefineProposal };
    }
  }
  return null;
}

/** Project the Refine subset of a ticket's activity log into ordered thread messages.
 *  Non-refine events are dropped; malformed detail falls back to empty text. Shared so the
 *  web thread view and the agent-worker's "what has been said so far" agree exactly. */
export function refineThreadFromEvents(events: TicketEvent[]): RefineMessage[] {
  const out: RefineMessage[] = [];
  for (const e of events) {
    const role: RefineRole | null =
      e.type === REFINE_EVENT_TYPE.human
        ? 'human'
        : e.type === REFINE_EVENT_TYPE.agent
          ? 'agent'
          : null;
    if (!role) continue;
    const detail = (e.detail ?? {}) as Partial<RefineDetail>;
    out.push({
      id: e.id,
      ticketId: e.ticketId,
      role,
      text: typeof detail.text === 'string' ? detail.text : '',
      createdAt: e.createdAt,
      ...(detail.round ? { round: detail.round } : {}),
      ...(detail.answers ? { answers: detail.answers } : {}),
    });
  }
  return out;
}

// ── Ticket Audit (D-045, PD-283) ──────────────────────────────────────────────
// The audit engine runs an autonomous agent over the backlog and records advisory
// findings; a human later Accepts/Rejects them (apply mechanics land in PD-287).

export const AUDIT_RUN_STATUSES = ['requested', 'running', 'done', 'error'] as const;
export type AuditRunStatus = (typeof AUDIT_RUN_STATUSES)[number];

export const FINDING_DECISIONS = ['undecided', 'accepted', 'rejected', 'other'] as const;
export type FindingDecision = (typeof FINDING_DECISIONS)[number];

/** Roll-up counts persisted on a finished run. `findings` + `tickets` + `projects` always
 *  present; per-recommendation buckets (e.g. `archive`, `complete`) are added opportunistically. */
export interface AuditRunCounts {
  projects: number;
  tickets: number;
  findings: number;
  [bucket: string]: number;
}

/** One audit pass. Created `requested` (by the weekly cron or POST), claimed to `running`
 *  by the worker, then `done`/`error`. `scope` describes what was audited (e.g. `single:PD`). */
export interface AuditRun {
  id: number;
  status: AuditRunStatus;
  scope: string | null;
  model: string | null;
  counts: AuditRunCounts | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

/** One advisory finding about a ticket (or, later, a relation). Never mutates the ticket —
 *  `decision` tracks the human's call. `confidence` is set by the verify stage (PD-284). */
export interface AuditFinding {
  id: number;
  runId: number;
  projectId: number | null;
  ticketId: number | null;
  /** Recommendation bucket: 'archive' | 'complete' | 'reprioritize' | 'update' | 'keep' | … */
  type: string;
  recommendation: string | null;
  reason: string | null;
  evidence: string | null;
  proposedChange: string | null;
  confidence: string | null;
  decision: FindingDecision;
  createdAt: number;
  updatedAt: number;
}

// ── System status (Site Status section) ──────────────────────────────────────
// Two cheap runtime signals surfaced above the board: how the Robot fleet is
// doing right now, and whether the out-of-process agent-worker is alive.

/** Liveness beacon written by a long-lived worker process (agent-worker) into the
 *  shared DB. The web server never talks to the worker directly — it reads this row.
 *  A worker is "stale" if `lastSeen` is older than a small multiple of its write
 *  interval (the UI decides the threshold). */
export interface WorkerHeartbeat {
  /** Stable worker identity, e.g. 'agent-worker'. One row per worker. */
  worker: string;
  /** Unix ms when the worker process started (resets on restart). */
  startedAt: number;
  /** Unix ms of the most recent heartbeat write. */
  lastSeen: number;
  /** OS pid of the worker process; null if unknown. */
  pid: number | null;
  /**
   * Short SHA of the worker's GROUNDING CHECKOUT HEAD — the code the agent READS. The worker
   * re-pulls it continuously, so this tracks `main` and changes without the worker restarting.
   *
   * This is NOT the worker's version. It was rendered as one until PD-528, which meant the Site
   * Status header showed a fresh-looking sha for a process running week-old code.
   */
  checkoutSha: string | null;
  /**
   * Short SHA the running image was BUILT from — the code the worker RUNS (PD-528). Baked in at
   * `docker build` time via `AGENT_WORKER_BUILD_SHA`. Null on an image built before that existed,
   * which the UI reports as unknown rather than falling back to a number that means something else.
   */
  buildSha: string | null;
  /** Model the worker's jobs run on; null if unknown. */
  model: string | null;
}

/** Whether the Robot loop's dispatch is globally paused (C2/PD-343). Set when a
 *  system-wide (auth/credit) fault is detected; cleared by a human (C4). Read by the
 *  server from the worker-owned `robot_state` k/v table. */
export interface DispatchPauseState {
  paused: boolean;
  /** The reason the loop paused (the triggering fault), or null when running. */
  reason: string | null;
  /** Unix ms the pause was set, or null when running. */
  since: number | null;
}

/** A self-expiring hold on dispatch after the provider reported a session/usage limit (PD-470).
 *  Unlike `DispatchPauseState` this needs no human: the loop resumes itself once `until` passes,
 *  and the status API reports an expired hold as none at all. */
/**
 * Which condition dispatch is waiting out (PD-470, PD-248). Both expire on their own and need no
 * human, but they have nothing else in common and the dashboard must not report the wrong one: a
 * session limit means the Anthropic quota is spent, a GitHub rate limit means the loop is hitting
 * the GitHub API too hard. The second is worth looking into; the first is just a wait.
 */
export type HoldKind = 'session-limit' | 'github-rate-limit';

export interface SessionLimitHoldState {
  /** Which condition is being waited out. Absent on rows written before PD-248 ⇒ 'session-limit'. */
  kind: HoldKind;
  /** Unix ms dispatch resumes — the time the provider stated, or a bounded fallback when its
   *  message carried no readable time. */
  until: number;
  /** The fault text that caused the hold. */
  reason: string;
  /** Unix ms the hold was set. */
  since: number;
}

/** The loop-wide budget ceiling and what has been spent against it (PD-463). The ceiling itself is
 *  worker config the web process cannot read, so the worker publishes it into `robot_state` and the
 *  server sums the window from `agent_runs`. `null` limits mean that limb is disabled. */
export interface RobotBudgetStatus {
  /** Rolling window the spend is measured over, ms. */
  windowMs: number;
  /** Turns spent in the window, and the ceiling (null when the turn limb is off). */
  turnsUsed: number;
  turnsLimit: number | null;
  /** Tokens spent in the window, and the ceiling (null when the token limb is off). */
  tokensUsed: number;
  tokensLimit: number | null;
}

/** Runtime status for the board's Site Status strip. `sortie` counts active
 *  (non-archived) tickets by agent state — only states with a non-zero count
 *  appear. `workers` is every known worker heartbeat. `dispatch` is the Robot
 *  loop's global running/paused state (C3/PD-344).
 *  NOTE: the `sortie` key is a stable wire-field name kept for the board's
 *  Site Status fetch; it carries the Robot loop's fleet counts. */
/* ── GitHub rate-limit headroom (PD-248) ──────────────────────────────────────
 * Read by a periodic `gh api rate_limit` probe in the worker. A probe rather than response headers
 * because the loop's GitHub calls go through the `gh` CLI, and `gh pr view` surfaces no
 * `x-ratelimit-*` headers at all — there is nothing to thread through.
 */

/** One GitHub rate-limit bucket. `resetAt` is epoch ms (GitHub reports seconds; the worker converts). */
export interface RateLimitBucket {
  remaining: number;
  limit: number;
  resetAt: number;
}

export interface GithubRateLimitStatus {
  /** The REST bucket — what `gh pr view` and `gh api` spend. */
  core: RateLimitBucket;
  /** The GraphQL bucket, when the probe reported one. Separate quota, separate reset. */
  graphql: RateLimitBucket | null;
  /** Epoch ms of the probe. Staleness matters: an old reading is not a healthy one. */
  checkedAt: number;
}

/** Headroom below which the UI calls it low. GitHub's REST core limit is 5,000/hr for a PAT, so
 *  10% is 500 calls — enough warning to act, not so tight that it fires on ordinary use. */
export const RATE_LIMIT_LOW_FRACTION = 0.1;

/** A probe older than this is reported as stale rather than current (the worker probes far more
 *  often than this; exceeding it means the probe itself is failing). */
export const RATE_LIMIT_STALE_MS = 30 * 60_000;

export type RateLimitHealth = 'ok' | 'low' | 'exhausted' | 'stale';

/**
 * Classify headroom for display. `stale` outranks the numbers on purpose: if the probe stopped
 * running, the last reading says nothing about now, and showing a comfortable "4,900 remaining"
 * from an hour ago is worse than showing nothing.
 */
export function rateLimitHealth(
  status: GithubRateLimitStatus | null,
  now: number,
): RateLimitHealth {
  if (!status) return 'stale';
  if (now - status.checkedAt > RATE_LIMIT_STALE_MS) return 'stale';
  const buckets = status.graphql ? [status.core, status.graphql] : [status.core];
  // Worst bucket wins — headroom in one quota is no comfort when the other is spent.
  if (buckets.some((b) => b.remaining <= 0)) return 'exhausted';
  if (buckets.some((b) => b.limit > 0 && b.remaining / b.limit < RATE_LIMIT_LOW_FRACTION))
    return 'low';
  return 'ok';
}

export interface SystemStatus {
  sortie: Partial<Record<AgentState, number>>;
  workers: WorkerHeartbeat[];
  dispatch: DispatchPauseState;
  /** PD-470: set while the loop is waiting out a provider session limit; null when it isn't. */
  sessionLimit: SessionLimitHoldState | null;
  /** PD-463: the loop-wide budget ceiling and spend against it; null until a worker publishes one. */
  budget: RobotBudgetStatus | null;
  /** PD-248: GitHub API headroom from the worker's periodic probe; null until one has run. */
  githubRateLimit: GithubRateLimitStatus | null;
  /**
   * PD-498: the open maintenance hold, or null.
   *
   * A FOURTH independent halt, alongside `dispatch.paused` and `sessionLimit`. It has to be here
   * rather than read separately by the nav, because the nav's whole job is to say why the loop is
   * not dispatching — and a condition it cannot see is one it will contradict. Before this, the nav
   * showed "Dispatch running" (true: `dispatch_paused` was clear) next to a maintenance-hold pill
   * (also true), which read as nonsense.
   */
  maintenanceHold: MaintenanceHoldStatus | null;
  /**
   * The tickets behind the "N needs you" count, newest first and capped (PD-498).
   *
   * The count alone sent the reader to the board to hunt for which ticket it meant — the exact trip
   * the number exists to save. With one parked ticket the nav links straight to it.
   */
  needsHuman: NeedsHumanTicket[];
}

/**
 * A ticket parked waiting on a human, as the nav needs it (PD-498).
 *
 * Carries `displayId` because that is what the detail-page route takes (and what a human
 * recognises), and `id` as the stable row key. The nav must link by `displayId` — an earlier version
 * linked `id`, which the route does not resolve.
 */
export interface NeedsHumanTicket {
  id: number;
  displayId: string | null;
  title: string;
  agentState: AgentState;
}

/** The subset of a maintenance hold the status API carries (PD-498). */
export interface MaintenanceHoldStatus {
  id: number;
  trigger: 'scheduled' | 'manual';
  /**
   * Which half of the hold we are in.
   *
   * **Both halves stop dispatch, which is why `queued` is reported at all.** The coordinator
   * refuses to dispatch from the moment a hold is *queued* — that is the whole drain mechanism —
   * and only then waits for the running Robots to finish before opening the window. Reporting the
   * active half alone would leave the nav saying "Loop on" through a drain that can last as long
   * as the longest run, and would leave a human who queues a ticket during it with no explanation
   * for why nothing picks it up.
   */
  phase: 'queued' | 'active';
  /** Epoch ms the window opened; null while still queued. */
  startedAt: number | null;
  /**
   * Epoch ms the window closes at the latest — `startedAt + HOLD_WINDOW_MS` — or null while
   * queued, because the window's clock does not start until the drain finishes. A countdown is
   * only honest once there is something bounded to count.
   */
  endsBy: number | null;
}

// ── Robot runs + milestones (C3/PD-344 observability) ────────────────────────
// The Robot loop (D-055) records one `agent_runs` row per attempt and emits
// milestone events onto the SAME `agent_ticket_events` timeline the Refine thread
// uses (reuse, not a parallel log). Both are read on the ticket-detail page.

/** How a Robot run ended. Mirrors the worker's `RunStatus` (agent-worker owns the
 *  write side; this is the read-side shape the server + web share). */
export type RobotRunStatus = 'running' | 'handed-off' | 'no-verify' | 'ask-human' | 'error';

/**
 * Is the running worker current with the code it is grounding against? (PD-528)
 *
 * `buildSha` is what the worker RUNS; `checkoutSha` is `main` as of the worker's last pull. When
 * they differ, the deploy is behind — the state Steve hit on 2026-08-13, where a container up 7
 * days would have silently ignored `EVALUATOR_ENABLED` because the Evaluator was not in its image.
 *
 * `unknown` is deliberately distinct from `stale`: an image predating the build-arg reports no
 * build sha at all, and "we cannot tell" must not render as "you are up to date".
 */
export type WorkerVersionState = 'current' | 'stale' | 'unknown';

export function workerVersionState(
  w: Pick<WorkerHeartbeat, 'buildSha' | 'checkoutSha'>,
): WorkerVersionState {
  if (!w.buildSha) return 'unknown';
  if (!w.checkoutSha) return 'unknown';
  return w.buildSha === w.checkoutSha ? 'current' : 'stale';
}

/** The fault taxonomy a failed run is classified into (C2/PD-343). */
export type RobotFaultTier = 'transient' | 'deterministic' | 'system-wide';

/** One Robot attempt on a ticket, as returned by `GET /tickets/:id/runs` (newest first). */
export interface AgentRun {
  id: number;
  ticketId: number;
  issueNumber: number | null;
  branch: string;
  status: RobotRunStatus;
  /** The coding SDK session id, for cross-referencing logs. */
  sessionId: string | null;
  prUrl: string | null;
  /** Raw error text on an errored run. */
  error: string | null;
  faultTier: RobotFaultTier | null;
  faultSignature: string | null;
  /** Human-readable reason a run parked/faulted, or the ask_human question. */
  faultReason: string | null;
  /** SDK turns the coding session used (null for older rows). */
  turns: number | null;
  /** Total tokens the coding session used (null for older rows). */
  tokens: number | null;
  /** Bounded (8 KB) tail of the coding session's assistant text + tool output (PD-426) — the
   *  evidence that makes a `no-verify` run diagnosable from the board after its worktree is gone.
   *  Null for older rows and for sessions that produced no output. */
  outputTail: string | null;
  /** PD-737/T898: the WIP ref (`robot-wip/t<id>`) a non-hand-off run pushed its work to, plus the
   *  commit sha at its tip, so a human can `git fetch` it. Null when the run handed off, preserved
   *  nothing, or the WIP push failed (and cleared once the ticket goes terminal). */
  wipRef: string | null;
  wipSha: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** `agent_ticket_events.type` values the Robot loop emits for the activity timeline.
 *  Referenced by BOTH the agent-worker (write) and the web (render), so the literals
 *  live here to keep them in lockstep (mirrors REFINE_EVENT_TYPE). */
export const ROBOT_EVENT = {
  dispatched: 'robot_dispatched',
  handoff: 'robot_handoff',
  fault: 'robot_fault',
  parked: 'robot_parked',
  askHuman: 'robot_ask_human',
  paused: 'robot_paused',
  // Human remediation actions (C4/PD-345). Written by the server when a button is clicked; they
  // also mark the retry-budget reset boundary the loop counts failures from.
  reset: 'robot_reset',
  unstick: 'robot_unstick',
  // Fold-the-bridges (C5/PD-346). `humanReply` is the DB-native ask_human answer, written by the
  // server's inline-reply route. `resumed` / `reactivated` / `stalled` are loop-written
  // milestones: resumed = an ask_human ticket re-queued after a human reply; reactivated = an
  // in-review ticket re-queued for rework (PR feedback or a merge conflict); stalled = in-process
  // stall detection parked an orphaned/over-long run.
  humanReply: 'robot_human_reply',
  resumed: 'robot_resumed',
  reactivated: 'robot_reactivated',
  stalled: 'robot_stalled',
  // Cutover (C6/PD-347): the board DB is authoritative and github-sync is retired, so the loop's
  // PR-state poll now owns TERMINAL transitions too (was github-sync's closed-issue→completed).
  // `completed` = the ticket's PR merged → Completed lane. `prClosed` = the PR was closed WITHOUT
  // merging → parked needs-human (a human abandoned it; the loop must not silently complete it).
  completed: 'robot_completed',
  prClosed: 'robot_pr_closed',
  // Manual terminal cleanup (PD-400): logged when a ticket is manually moved to `completed`/`closed`
  // and its lingering agent session is torn down (agent_state cleared, needs/awaiting-human
  // notifications resolved). Not written by the loop — by the server's terminal-transition path.
  sessionEnded: 'robot_session_ended',
  // The Evaluator (PD-487, D-076). `evaluating` is written when a pass STARTS and `evaluated` when
  // it produces a verdict — the pair, not just the verdict, because a failed evaluation deliberately
  // writes no verdict (so it can never be mistaken for approval). Without a start marker that
  // failure would be invisible on the timeline; with it, "reviewing…" and no verdict is legible as
  // exactly what happened. `evaluated` is written on EVERY verdict, since a timeline that only shows
  // the Evaluator complaining reads as noise, and "it reviewed this and was satisfied" is what a
  // human most wants to know before merging.
  evaluating: 'robot_evaluating',
  evaluated: 'robot_evaluated',
  // PD-774 (D-099): the conflict resolver merged main into the ticket's PR and resolved the conflicts
  // mechanically. It also marks a new review boundary: the Evaluator reviews the resolved head again.
  conflictResolved: 'robot_conflict_resolved',
  // PD-773: screenshots of the PR's head were captured and are served by the dashboard.
  visualCaptured: 'robot_visual_captured',
  // PD-773 slice 2: the Robot or the Evaluator asked for Steve's visual check of a PR, and his answer.
  visualReviewRequested: 'robot_visual_review_requested',
  visualReviewed: 'robot_visual_reviewed',
} as const;

/** The two remediation events that reset a ticket's retry-budget boundary — the loop counts
 *  failures with `started_at` AFTER the newest of these. */
export const ROBOT_RESET_EVENTS: readonly string[] = [ROBOT_EVENT.reset, ROBOT_EVENT.unstick];

export type RobotEventType = (typeof ROBOT_EVENT)[keyof typeof ROBOT_EVENT];

/**
 * The human-readable line for a `robot_evaluated` event (PD-487, [[D-076]]).
 *
 * Here rather than inside `ActivityTimeline.svelte` so the ticket-detail timeline and the Activity
 * Feed (PD-162) render the same words from one source — a `.svelte` `describe()` is also not
 * directly testable, and the counts are the part worth asserting.
 *
 * The counts carry the meaning. "revise" alone says a machine disagreed; "revise — 2 blocking
 * findings" says how much work it thinks is left. A `ship` that carried advisory notes is
 * distinguished from a clean one, because those notes are the reason to open the PR and look.
 */
export function evaluatorVerdictLine(detail: RobotEventDetail): string {
  // PD-767: two reviewers write verdicts now; say which one this is when it is not the default.
  const line = codeVerdictLine(detail);
  return detail.lens === 'security' ? `security: ${line}` : line;
}

function codeVerdictLine(detail: RobotEventDetail): string {
  const verdict = detail.verdict ?? 'unknown';
  const total = detail.findings ?? 0;
  const blocking = detail.blockingFindings ?? 0;
  const advisory = Math.max(0, total - blocking);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (verdict === 'revise') return `revise — ${plural(blocking, 'blocking finding')} to fix`;
  if (verdict === 'escalate') return 'escalate — needs a human decision before more work';
  if (verdict === 'ship')
    return advisory > 0 ? `ship, with ${plural(advisory, 'advisory note')}` : 'ship — no findings';
  return verdict;
}

/** JSON stored in a `robot_*` event's `detail` (all fields optional — depends on type). */
export interface RobotEventDetail {
  branch?: string;
  prUrl?: string;
  tier?: RobotFaultTier;
  reason?: string;
  question?: string;
  state?: string;
  /** The human's answer text (`robot_human_reply`). */
  text?: string;
  /** PR number a rework was triggered from (`robot_reactivated`), or resolved (`robot_conflict_resolved`). */
  prNumber?: number;
  /** PD-774: the files the conflict resolver resolved (`robot_conflict_resolved`). */
  files?: string[];
  /** PD-773: who asked for a visual check (`robot_visual_review_requested`). */
  by?: 'robot' | 'evaluator';
  /** PD-773: Steve's visual verdict and note (`robot_visual_reviewed`). */
  approved?: boolean;
  note?: string;
  /** PD-773: the screenshots of a capture, each with its dashboard URL (`robot_visual_captured`). */
  shots?: VisualShot[];
  /** PD-798: on `robot_visual_captured`, the click steps that could not run. */
  failures?: VisualStepFailure[];
  /** How long a stalled run had been running before the watchdog parked it, ms (`robot_stalled`). */
  ageMs?: number;
  /** Terminal lane a manual close/complete moved the ticket to (`robot_session_ended`, PD-400). */
  to?: string;
  /** The agent_state that was cleared, if any (`robot_session_ended`). */
  clearedAgentState?: string;
  /** How many needs/awaiting-human notifications were resolved (`robot_session_ended`). */
  resolvedNotifications?: number;
  /** True when an active refine session was ended by the terminal transition (`robot_session_ended`). */
  endedRefine?: boolean;
  /** PD-432: the effective turn ceiling a dispatched run was given (`robot_dispatched`) — the
   *  ticket's override, or the loop's env default. */
  maxTurns?: number;
  /** PD-487: the Evaluator's verdict (`robot_evaluated`). */
  verdict?: EvaluatorVerdict;
  /** PD-767: which reviewer wrote this `robot_evaluating`/`robot_evaluated` event. Absent = code. */
  lens?: 'code' | 'security';
  /** PD-487: how many findings the verdict carried, and how many of those were blocking. */
  findings?: number;
  blockingFindings?: number;
  /** PD-487: which evaluation round this was for the ticket — the loop caps them (D-076). */
  round?: number;
  /** PD-470: on a `robot_paused` raised by a provider session limit — the flag distinguishes it
   *  from an auth/credit pause (which needs a human), and `until` is when dispatch resumes. */
  sessionLimit?: boolean;
  until?: number;
  /** PD-737/T898: on a `robot_fault`/`robot_parked`/`robot_paused`/`robot_ask_human` event whose run
   *  preserved its work — the WIP ref (`robot-wip/t<id>`) and the commit sha at its tip. */
  wipRef?: string;
  wipSha?: string;
}
