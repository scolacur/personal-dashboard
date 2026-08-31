<script lang="ts">
  import { toast } from '$lib/toast-store.svelte';
  import { queuedDuringHoldNotice } from '$lib/maintenance-display';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AgentProject, AgentState, AgentTicket, TicketPriority, TicketStatus, TicketRelation, EpicSummary, EpicDerivedLane, UpdateTicketInput } from '@dashboard/shared';
  import { isReady } from '@dashboard/shared';
  import GlossaryModal from '$lib/GlossaryModal.svelte';
  import TicketCard from '../TicketCard.svelte';
  import EpicCard from '../EpicCard.svelte';
  import RelationPicker from '../RelationPicker.svelte';
  import EpicPicker from '../EpicPicker.svelte';
  import BoardToolbar from './BoardToolbar.svelte';
  import TicketFormModal from './TicketFormModal.svelte';
  import EpicLane from './EpicLane.svelte';
  import TicketBoard from './TicketBoard.svelte';
  import ArchiveEpicModal from './ArchiveEpicModal.svelte';
  import QueueBypassModal from './QueueBypassModal.svelte';
  import EpicRollbackModal from './EpicRollbackModal.svelte';
  import SpinOffModal from './SpinOffModal.svelte';
  import { emptyTicketForm, epicRequired, ticketToForm, type TicketFormState } from './ticket-form';
  import { planSpinOff, type SpinOffPlan } from '../epic-spinoff';
  import { computeBadges, type RelationAction, type RelationBadges } from '../relation-logic';
  import { buildEpicBand, type EpicBandCell } from '../epic-logic';
  import {
    isDraggableEpicLane,
    membersOf,
    planEpicQueue,
    planEpicRollback,
    rollbackNeedsConfirm,
    splitEpicTitle,
    type EpicQueuePlan,
    type EpicRollbackPlan,
  } from '../epic-drag';
  import * as api from '../api';
  import { ticketMatchesQuery, ticketMatchesRefineFilter, ticketMatchesAssigneeFilter } from '../filter-logic';
  import type { RefineFilter, AssigneeFilter } from '../filter-logic';
  import { compareTicketsInColumn } from '../sort-logic';
  import { buildCopyText, copyToClipboard } from '../copy-utils';
  import {
    isStatusLocked,
    isReadOnly,
    isTerminal,
    computeSortOrder,
    clampEpicHeight,
  } from '../board-logic';
  import { moveIsNoop, needsQueueBypass, pickBeforeId, type DropCandidate } from '../board-drag';

  const COLUMNS: { status: TicketStatus; label: string; defaultHidden?: boolean }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'queue', label: 'Queue' },
    { status: 'completed', label: 'Completed' },
    { status: 'closed', label: 'Closed', defaultHidden: true },
  ];

  const LANE_VISIBILITY_KEY = 'task-monitor:hidden-lanes';
  const EPIC_HEIGHT_KEY = 'task-monitor:epic-area-height';
  const EPIC_HEIGHT_DEFAULT = 200; // px — matches the previous hard-coded 12.5rem

  function loadHiddenLanes(): SvelteSet<TicketStatus> {
    const defaults = new SvelteSet(COLUMNS.filter((c) => c.defaultHidden).map((c) => c.status));
    // Runs during SSR (component init) where localStorage doesn't exist — return
    // defaults on the server; the browser reads the persisted preference.
    if (!browser) return defaults;
    const stored = localStorage.getItem(LANE_VISIBILITY_KEY);
    if (stored === null) return defaults;
    try {
      const parsed = JSON.parse(stored) as TicketStatus[];
      return new SvelteSet(parsed);
    } catch (err) {
      console.warn('[task-monitor] failed to parse hidden lanes from localStorage', err);
      return defaults;
    }
  }

  function saveLaneVisibility(hidden: SvelteSet<TicketStatus>) {
    try {
      localStorage.setItem(LANE_VISIBILITY_KEY, JSON.stringify([...hidden]));
    } catch (err) {
      console.warn('[task-monitor] failed to persist lane visibility', err);
    }
  }

  function loadEpicAreaHeight(): number {
    if (!browser) return EPIC_HEIGHT_DEFAULT;
    const stored = localStorage.getItem(EPIC_HEIGHT_KEY);
    if (stored === null) return EPIC_HEIGHT_DEFAULT;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? clampEpicHeight(parsed) : EPIC_HEIGHT_DEFAULT;
  }

  function saveEpicAreaHeight(height: number) {
    try {
      localStorage.setItem(EPIC_HEIGHT_KEY, String(height));
    } catch (err) {
      console.warn('[task-monitor] failed to persist epic area height', err);
    }
  }

  let hiddenLanes = $state(loadHiddenLanes());
  let epicAreaHeight = $state(loadEpicAreaHeight());
  let resizing = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;

  function onResizeStart(e: PointerEvent) {
    e.preventDefault();
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartHeight = epicAreaHeight;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    epicAreaHeight = clampEpicHeight(resizeStartHeight + (e.clientY - resizeStartY));
  }

  function onResizeEnd() {
    if (!resizing) return;
    resizing = false;
    saveEpicAreaHeight(epicAreaHeight);
  }

  function toggleLane(status: TicketStatus) {
    if (hiddenLanes.has(status)) {
      hiddenLanes.delete(status);
    } else {
      hiddenLanes.add(status);
    }
    saveLaneVisibility(hiddenLanes);
  }

  // Glossary modal (unified: priority levels, refinement statuses, robot statuses).
  let glossaryOpen = $state(false);
  let glossaryTab = $state<'priority' | 'refinement' | 'robot'>('priority');
  let glossaryHighlightState = $state<AgentState | null>(null);

  let tickets = $state<AgentTicket[]>([]);
  let projects = $state<AgentProject[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // null = "All projects"
  let filterProjectId = $state<number | null>(null);

  // Priority filter: 'all' (no filter), 'none' (unset), or a specific P-level.
  let filterPriority = $state<'all' | 'none' | TicketPriority>('all');

  // Refinement filter: 'all' (no filter), or a specific refinement state.
  let filterRefine = $state<RefineFilter>('all');

  // Assignee filter (D-058, PD-399): table-wide across every lane — the single Queue intermixes
  // robot- and steve-assigned cards, so a lane-independent filter is how you isolate one assignee.
  // Persisted like hidden lanes so the view survives reloads.
  const ASSIGNEE_FILTER_KEY = 'task-monitor:filter-assignee';
  function loadAssigneeFilter(): AssigneeFilter {
    if (!browser) return 'all';
    const stored = localStorage.getItem(ASSIGNEE_FILTER_KEY);
    if (stored === 'robot' || stored === 'steve' || stored === 'none') return stored;
    return 'all';
  }
  let filterAssignee = $state<AssigneeFilter>(loadAssigneeFilter());
  function setAssigneeFilter(value: AssigneeFilter) {
    filterAssignee = value;
    try {
      localStorage.setItem(ASSIGNEE_FILTER_KEY, value);
    } catch (err) {
      console.warn('[task-monitor] failed to persist assignee filter', err);
    }
  }

  // Free-text filter over ticket title + body (case-insensitive).
  let search = $state('');

  // Lanes group by priority (P0 on top … P5, then unset at the bottom). A card can only be
  // reordered within its own band and never dragged into another band — the band rules moved to
  // `board-drag.ts` with the drag itself (PD-554).
  // Key used for the card's data-priority attribute + band comparisons.
  function bandKey(p: TicketPriority | null): string {
    return p ?? 'none';
  }

  // Add / edit form state. `editingId === null` while adding; the modal mutates `form` in place.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let editingLocked = $state(false);
  let form = $state<TicketFormState>(emptyTicketForm('backlog', null));

  // Epics selectable as a parent in the form's "Belongs to epic" dropdown — same project,
  // excluding the ticket being edited (no nesting / self).
  const epicOptions = $derived(
    tickets.filter((t) => t.isEpic && t.projectId === form.projectId && t.id !== editingId),
  );

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));
  const ticketsById = $derived(new Map(tickets.map((t) => [t.id, t])));

  // Relations (PD-322): fetched once for the whole board; card badges derive from these plus a
  // status lookup, so an unresolved-blocker count never costs a per-card request.
  let relations = $state<TicketRelation[]>([]);
  const statusById = $derived(new Map(tickets.map((t) => [t.id, t.status])));
  const badgesById = $derived(
    new Map(tickets.map((t) => [t.id, computeBadges(t.id, relations, statusById)])),
  );
  const NO_BADGES: RelationBadges = { blockedBy: 0, blocking: 0, split: false, splitOrigin: null };

  // Epics (D-054, PD-337): summaries drive each Epic card's derived board lane + roll-up. Fetched
  // in bulk alongside tickets (sparse). Epics render in the top band; tickets in the bottom band.
  let epicSummaries = $state<EpicSummary[]>([]);
  const epicSummaryById = $derived(new Map(epicSummaries.map((s) => [s.ticketId, s])));

  // D-054: a non-empty Epic's lane is *derived* from its members, so its own status is inert —
  // setting it in the form silently no-ops. Lock the Status field for that case and explain why.
  // D-080 slice C: a Ticket may be moved between Epics, never out of one.
  const editingHadEpic = $derived(
    editingId !== null && (ticketsById.get(editingId)?.epicId ?? null) !== null,
  );
  const formRequiresEpic = $derived(
    epicRequired({ creating: editingId === null, hadEpic: editingHadEpic, status: form.status }),
  );

  const editingEpicWithMembers = $derived(
    editingId !== null && form.isEpic && (epicSummaryById.get(editingId)?.total ?? 0) > 0,
  );

  // Ticket-type filter (D-054): All shows both bands; Epics-only hides the ticket band;
  // Tickets-only hides the epic band; Epics & Lone Tickets shows epics + only the tickets
  // that don't belong to an epic.
  let filterType = $state<'all' | 'epics' | 'tickets' | 'epics-lone'>('all');
  const showEpics = $derived(filterType !== 'tickets');
  const showTickets = $derived(filterType !== 'epics');

  // Ticket-relation picker (kebab → "Mark as →"). The board owns the single picker instance
  // since it holds the full ticket list + relations the picker filters against.
  let pickerOpen = $state(false);
  let pickerAction = $state<RelationAction | null>(null);
  let pickerSource = $state<AgentTicket | null>(null);

  function openRelationPicker(ticket: AgentTicket, action: RelationAction) {
    pickerSource = ticket;
    pickerAction = action;
    pickerOpen = true;
  }

  // Epic membership (D-054, PD-338): the kebab "Add to Epic…" opens a picker to set epic_id.
  let epicPickerOpen = $state(false);
  let epicPickerSource = $state<AgentTicket | null>(null);

  function openEpicPicker(ticket: AgentTicket) {
    epicPickerSource = ticket;
    epicPickerOpen = true;
  }

  async function setTicketEpic(ticketId: number, epicId: number | null) {
    error = null;
    try {
      await api.updateTicket(ticketId, { epicId });
      await load(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg);
    }
  }

  function visibleTickets(): AgentTicket[] {
    return tickets.filter((t) => {
      if (filterProjectId !== null && t.projectId !== filterProjectId) return false;
      if (filterPriority !== 'all' && bandKey(t.priority) !== filterPriority) return false;
      if (!ticketMatchesAssigneeFilter(t, filterAssignee)) return false;
      if (!ticketMatchesRefineFilter(t, filterRefine)) return false;
      if (!ticketMatchesQuery(t, search)) return false;
      return true;
    });
  }

  // Ticket band excludes Epics — Epics render in the top band by their derived lane (D-054).
  // 'epics-lone' further drops tickets that belong to an epic, leaving only free-standing ones.
  function byStatus(status: TicketStatus): AgentTicket[] {
    return visibleTickets()
      .filter((t) => t.status === status && !t.isEpic)
      .filter((t) => filterType !== 'epics-lone' || t.epicId === null)
      .sort((a, b) => compareTicketsInColumn(status, a, b));
  }

  const visibleColumns = $derived(COLUMNS.filter((c) => !hiddenLanes.has(c.status)));
  // Epic band cells over the visible columns (In-Progress sits over the single Queue column, D-058).
  const epicBandCells = $derived(
    buildEpicBand(
      visibleTickets().filter((t) => t.isEpic),
      epicSummaryById,
      visibleColumns.map((c) => c.status),
    ),
  );

  async function load(silent = false) {
    if (!silent) loading = true;
    error = null;
    try {
      [projects, tickets, relations, epicSummaries] = await Promise.all([
        api.fetchProjects(),
        api.fetchTickets(),
        api.fetchAllRelations(),
        api.fetchEpicSummaries(),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (!silent) loading = false;
    }
  }

  onMount(() => {
    // Paint the board from the current DB. The server cron keeps the DB reconciled with
    // GitHub, and the background auto-refresh below re-reads it periodically.
    load();
    // Background auto-refresh every 30 s. Reads the DB only; the server cron keeps it fresh
    // for idle tabs.
    const refreshTimer = setInterval(() => load(true), 30_000);
    return () => clearInterval(refreshTimer);
  });

  function openAdd(status: TicketStatus = 'backlog') {
    editingId = null;
    editingLocked = false;
    // Default to the active filter, else "personal-dashboard", else the first project.
    const personalDashboard = projects.find((p) => p.slug === 'personal-dashboard');
    form = emptyTicketForm(status, filterProjectId ?? personalDashboard?.id ?? projects[0]?.id ?? null);
    formOpen = true;
  }

  // Create an Epic from the Epic band's `+` (Backlog only, D-080).
  function openAddEpic(status: TicketStatus) {
    openAdd(status);
    form.isEpic = true;
  }

  function openEdit(ticket: AgentTicket) {
    if (isReadOnly(ticket) && isTerminal(ticket)) {
      showToast(`${ticket.displayId ?? ticket.title} is read-only — Reopen it from its detail page.`);
      return;
    }
    editingId = ticket.id;
    editingLocked = isStatusLocked(ticket);
    form = ticketToForm(ticket, projects[0]?.id ?? null);
    formOpen = true;
  }

  function closeForm() {
    formOpen = false;
  }

  async function submitForm() {
    const title = form.title.trim();
    if (!title || form.projectId === null) return;
    // D-058: editing/creating an unformatted robot ticket into the Queue needs an explicit bypass ack.
    // Skip the prompt for a ticket that's already bypassed (editing it shouldn't re-ask) and for an
    // agent-locked ticket (its status isn't sent). Confirm sets `readyBypassed`; cancel aborts.
    const existing = editingId !== null ? tickets.find((t) => t.id === editingId) : undefined;
    const needsBypass =
      form.status === 'queue' &&
      form.assignee === 'robot' &&
      !isReady(form.body.trim() || null) &&
      !(existing?.readyBypassed ?? false) &&
      !(editingId !== null && editingLocked);
    if (needsBypass) {
      queueConfirm = { label: title, run: () => writeForm(true) };
      return;
    }
    await writeForm(false);
  }

  async function writeForm(bypass: boolean) {
    const title = form.title.trim();
    if (!title || form.projectId === null) return;
    error = null;
    let minted: AgentTicket | null = null;
    try {
      // An Epic never belongs to another Epic (no nesting, D-054).
      // Slice C: a drafted Epic is minted first, so the Ticket can be created already belonging to
      // it. Created first rather than after-and-patched because the server sets a member's priority
      // from its Epic on write — attaching afterwards would write the Ticket's own priority once,
      // then overwrite it, which reads as a flicker and logs a change that never meant anything.
      let epicId = form.isEpic ? null : form.epicId;
      if (!form.isEpic && form.newEpic !== null && form.newEpic.title.trim()) {
        const mintedEpic = await api.createTicket({
          title: form.newEpic.title.trim(),
          projectId: form.projectId,
          priority: form.newEpic.priority,
          status: 'backlog',
          isEpic: true,
          body: null,
        });
        epicId = mintedEpic.id;
        minted = mintedEpic;
      }
      // Blank = clear the override (inherit the loop default). NaN can't reach here: the input is
      // type=number and the Save button gates on the modal's `maxTurnsInvalid`.
      const maxTurns = form.maxTurns.trim() === '' ? null : Number(form.maxTurns);
      if (editingId === null) {
        const created = await api.createTicket({
          title,
          projectId: form.projectId,
          body: form.body.trim() || null,
          priority: form.priority,
          status: form.status,
          assignee: form.assignee,
          isEpic: form.isEpic,
          epicId,
          maxTurns,
        });
        // CreateTicketInput carries no `readyBypassed` (backend enum/guards are ticket A's scope) —
        // set it in a follow-up patch when the human bypassed the formatting gate at create time.
        if (bypass) await api.updateTicket(created.id, { readyBypassed: true });
      } else {
        await api.updateTicket(editingId, {
          title,
          body: form.body.trim() || null,
          priority: form.priority,
          projectId: form.projectId,
          assignee: form.assignee,
          isEpic: form.isEpic,
          epicId,
          maxTurns,
          // Don't send status for agent-locked tickets (it's externally controlled).
          ...(editingLocked ? {} : { status: form.status }),
          ...(bypass ? { readyBypassed: true } : {}),
        });
      }
      formOpen = false;
      await load(true);
      if (minted) showToast(`Created Epic ${minted.displayId} — ${title} is its first member.`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // The Epic may have been minted before the Ticket failed. Say so rather than leaving an
      // empty Epic on the board with no explanation for where it came from.
      if (minted) {
        error += ` (Epic ${minted.displayId} was created before this failed — it is now empty.)`;
      }
    }
  }

  // Duplicate a ticket into the backlog with a "[Duplicate]" title prefix.
  async function duplicate(ticket: AgentTicket) {
    if (ticket.projectId === null) return;
    error = null;
    try {
      await api.createTicket({
        title: `[Duplicate] ${ticket.title}`,
        projectId: ticket.projectId,
        body: ticket.body,
        priority: ticket.priority,
        status: ticket.status,
      });
      await load(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /* ── Drag & drop ──────────────────────────────────
     Native HTML5 DnD. A single dragover handler on each column body computes the
     insertion point by comparing the pointer to each card's vertical midpoint, so
     reordering within a lane and moving between lanes share one code path. */
  // Where the dragged card would land: `beforeId === null` means append to the end.

  // Toast promoted to `$lib/toast.svelte` + `$lib/Toast.svelte` (PD-334) once the shell's
  // membership writes became a second caller. `<Toast />` is mounted in the root layout.
  const showToast = (message: string, ms?: number) => toast.show(message, 'info', ms);

  // The maintenance-hold notice is three sentences and explains why the thing you just did will
  // not visibly do anything — the 3s default is not enough time to read it, and re-reading is not
  // an option once it is gone.
  const HOLD_TOAST_MS = 12_000;

  // Queue-bypass confirm (D-058, PD-399): queueing an unformatted robot ticket pops this modal —
  // confirm sets `readyBypassed` (honest override, never fakes `ready`) and completes the move;
  // cancel aborts, leaving the card where it was (no optimistic move happened).
  let queueConfirm = $state<{ label: string; run: () => Promise<void> } | null>(null);
  async function acceptQueueConfirm() {
    const pending = queueConfirm;
    queueConfirm = null;
    if (pending) await pending.run();
  }
  function cancelQueueConfirm() {
    queueConfirm = null;
  }

  // Shared write path for a drag/drop move. A blocked ticket may now sit in the queue (D-051 amended
  // by PD-408 — the loop skips it at selection), so a drop into the queue is no longer refused; any
  // remaining error (epic guard, etc.) surfaces in the banner.
  async function applyTicketMove(id: number, patch: UpdateTicketInput) {
    error = null;
    try {
      await api.updateTicket(id, patch);
      await load(true);
      if (patch.status === 'queue') {
        const ticket = tickets.find((t) => t.id === id);
        const notice = await holdNotice(ticket?.displayId ?? ticket?.title);
        if (notice) showToast(notice, HOLD_TOAST_MS);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * The "nothing will pick this up yet" notice, or null when dispatch is running (PD-498).
   *
   * **Fetched on the action rather than polled.** The board has no reason to watch the loop's
   * status the rest of the time, and a 30s-stale poll is exactly wrong here: a hold that opened or
   * closed in the last half-minute would produce a toast that contradicts what actually happens to
   * the ticket. One request, at the moment the claim is made.
   *
   * Failure is silent by design — this is an explanation, not the operation. A board that reported
   * "couldn't check the maintenance hold" after a move that plainly succeeded would be worse than
   * one that says nothing.
   */
  async function holdNotice(label?: string): Promise<string | null> {
    try {
      const status = await api.fetchSystemStatus();
      return queuedDuringHoldNotice(status.maintenanceHold, Date.now(), label);
    } catch {
      return null;
    }
  }

  /**
   * Commit a ticket drag (PD-554). `TicketBoard` owns the gesture and the insertion maths; this is
   * the part that is this page's — what a move MEANS here, including the Ready-bypass confirm.
   */
  async function onBoardMove(ticket: AgentTicket, status: TicketStatus, beforeId: number | null) {
    const sortOrder = computeSortOrder(byStatus(status), ticket.priority, beforeId, ticket.id);
    if (moveIsNoop(ticket, status, sortOrder)) return;
    // D-058: dragging an unformatted robot ticket into the Queue needs an explicit bypass ack. Defer
    // the move to the confirm modal; confirming sets `readyBypassed` and completes it.
    if (needsQueueBypass(ticket, status)) {
      queueConfirm = {
        label: ticket.displayId ?? ticket.title,
        run: () => applyTicketMove(ticket.id, { status, sortOrder, readyBypassed: true }),
      };
      return;
    }
    await applyTicketMove(ticket.id, { status, sortOrder });
  }

  /* ── Epic drag (D-080) ──────────────────────────────────────────
     Two moves share one gesture. Dropping an Epic in its OWN lane reorders it there (D-054 as
     amended by PD-337) — that ordering is what ranks equal-priority Epics for dispatch. Dropping
     it in the OTHER pending lane moves the Epic itself, and the server cascades to its members:
     queueing arms everything unstarted, rolling back un-queues everything that never started.

     `completed`/`closed` are not drop targets. Those lanes are derived from what the members
     actually reached, so dropping a card into one would assert work the loop never did.

     Separate drag state from tickets so the two bands don't cross-react. */
  let epicDraggingId = $state<number | null>(null);
  let epicDropTarget = $state<{ lane: EpicDerivedLane; beforeId: number | null } | null>(null);

  // Rollback confirm — opened only when some member's work is in flight and cannot be recalled.
  let rollbackTarget = $state<AgentTicket | null>(null);
  let rollbackPlan = $state<EpicRollbackPlan>({ inFlight: [], pullBack: [], movesEpic: true });
  let rollbackBusy = $state(false);

  const laneOfEpic = (id: number): EpicDerivedLane | undefined =>
    epicSummaryById.get(id)?.derivedLane;

  function onEpicDragStart(e: DragEvent, epic: AgentTicket) {
    // An Epic in a terminal lane is there because its members finished. Dropping it back would
    // write a status the derived lane immediately overrules, so the card would snap back with no
    // explanation — refuse the drag and say why instead.
    const lane = laneOfEpic(epic.id);
    if (lane !== undefined && !isDraggableEpicLane(lane)) {
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'none';
      e.preventDefault();
      showToast(
        `${epic.displayId ?? epic.title} is ${lane === 'completed' ? 'Completed' : 'Closed'} ` +
          'because its members are — reopen a member to bring the Epic back.',
      );
      return;
    }
    epicDraggingId = epic.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(epic.id));
    }
  }

  function onEpicDragEnd() {
    epicDraggingId = null;
    epicDropTarget = null;
  }

  function onEpicCellDragOver(e: DragEvent, cell: EpicBandCell) {
    if (epicDraggingId === null) return;
    // Backlog and In Progress accept a drop (reorder within, move across). The terminal lanes
    // never do — an Epic gets there by its members finishing, not by being dragged.
    if (!isDraggableEpicLane(cell.lane)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // PD-538: the same insertion maths the Ticket band uses. It used to be a hand-rolled
    // "first card whose midpoint you are above", which was correct while the band was a flat
    // hand-ordered list; now that the band is priority-banded, a drop has to be clamped to the
    // dragged Epic's own band — and falling past the last card of that band means the END OF THE
    // BAND, not the end of the lane. `pickBeforeId` is that rule, and it is tested.
    const dragged = tickets.find((t) => t.id === epicDraggingId);
    if (!dragged) return;
    const candidates: DropCandidate[] = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.epic-card'),
    ]
      .filter((el) => Number(el.dataset.id) !== epicDraggingId)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          id: Number(el.dataset.id),
          priority: el.dataset.priority ?? 'none',
          midpointY: rect.top + rect.height / 2,
        };
      });
    epicDropTarget = {
      lane: cell.lane,
      beforeId: pickBeforeId(candidates, dragged.priority, e.clientY),
    };
  }

  async function onEpicDrop(e: DragEvent, cell: EpicBandCell) {
    e.preventDefault();
    const id = epicDraggingId;
    const target = epicDropTarget;
    epicDraggingId = null;
    epicDropTarget = null;
    if (id === null || !isDraggableEpicLane(cell.lane)) return;
    const epic = tickets.find((t) => t.id === id);
    if (!epic) return;

    // Same lane → reorder among that cell's Epics.
    // PD-538: `computeSortOrder`, not `computeOrderWithin` — the band is priority-banded now, so
    // the fractional order must be computed against the dragged Epic's OWN band. `beforeId` can
    // legitimately point at the first card of the next band (the boundary case), which
    // `computeSortOrder` already handles by appending to the end of this one.
    if (laneOfEpic(id) === cell.lane) {
      const sortOrder = computeSortOrder(cell.epics, epic.priority, target?.beforeId ?? null, id);
      if (epic.sortOrder === sortOrder) return;
      await applyEpicPatch(id, { sortOrder });
      return;
    }

    // Across lanes → move the Epic; the server cascades to its members.
    const members = membersOf(id, tickets);
    if (cell.lane === 'in_progress') {
      const plan = planEpicQueue(members);
      await applyEpicPatch(id, { status: 'queue' });
      // Appended rather than shown separately: `toast.show` replaces whatever is current, so a
      // second call would eat the "Epic queued. Contains: …" breakdown the user asked for.
      const notice = await holdNotice(`Epic ${epic.displayId ?? epic.title}`);
      showToast(queuedToast(epic, plan) + (notice ? `\n\n${notice}` : ''), notice ? HOLD_TOAST_MS : undefined);
      return;
    }

    // → Backlog. The modal appears only to report work that cannot be recalled.
    const plan = planEpicRollback(members);
    if (rollbackNeedsConfirm(plan)) {
      rollbackPlan = plan;
      rollbackTarget = epic;
      return;
    }
    await runRollback(epic, plan);
  }

  /** "N tickets" / "1 ticket". */
  const count = (n: number, noun = 'ticket') => `${n} ${noun}${n === 1 ? '' : 's'}`;

  function queuedToast(epic: AgentTicket, plan: EpicQueuePlan): string {
    const label = epic.displayId ?? epic.title;
    if (plan.armed.length === 0) return `Epic ${label} queued. Nothing new to arm.`;
    const lines = [
      `Epic ${label} queued. Contains:`,
      `${count(plan.dispatchable.length)} ready for dispatch`,
      // PD-591: "not formatted" rather than "not ready" — this count IS the formatting check
      // (`ready || readyBypassed`), and the badge on the card now says the same word.
      `${count(plan.notReady.length)} not formatted for dispatch`,
    ];
    // Only when it applies — otherwise the two counts above would silently not add up to what
    // was actually queued.
    if (plan.human.length > 0) lines.push(`${count(plan.human.length)} assigned to a human`);
    return lines.join('\n');
  }

  async function applyEpicPatch(id: number, patch: UpdateTicketInput) {
    error = null;
    try {
      await api.updateTicket(id, patch);
      await load(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Return an Epic's recallable members to Backlog.
   *
   * The Epic itself moves only when nothing is in flight (`plan.movesEpic`). With a live run its
   * lane derives to `in_progress` regardless, so writing `backlog` on it would set a status the
   * view immediately overrules — the card would not move and the Epic would quietly disagree with
   * the lane it is drawn in. Leaving it in the Queue is just the truth.
   */
  async function runRollback(epic: AgentTicket, plan: EpicRollbackPlan) {
    error = null;
    try {
      for (const m of plan.pullBack) {
        await api.updateTicket(m.id, { status: 'backlog' });
      }
      if (plan.movesEpic) await api.updateTicket(epic.id, { status: 'backlog' });
      await load(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function confirmRollback() {
    const epic = rollbackTarget;
    const plan = rollbackPlan;
    rollbackTarget = null;
    if (epic) await runRollback(epic, plan);
  }

  /**
   * Bump the in-flight members into a new Epic so this one can leave the Queue.
   *
   * The run cannot be stopped, but nothing says the *Epic* has to wait for it. Since the Epic is
   * the unit of dispatch (D-080), scheduling the live ticket and the shelved ones
   * differently requires two Epics — so this is the model working rather than a way around it.
   *
   * Order matters. The new Epic carries the original's priority so that re-parenting a member
   * doesn't silently re-price it (the server pushes the Epic's priority onto every member it
   * takes). Members move out before the Epic's own status is written, so that by the time it is
   * written nothing is left in `queue` to make the derived lane contradict it.
   */
  async function bumpActiveOut() {
    const epic = rollbackTarget;
    const plan = rollbackPlan;
    rollbackTarget = null;
    if (!epic || epic.projectId === null) return;
    error = null;
    rollbackBusy = true;
    try {
      const spun = await api.createTicket({
        title: splitEpicTitle(epic.title),
        projectId: epic.projectId,
        priority: epic.priority,
        status: 'queue',
        isEpic: true,
        body:
          `*Split out of ${epic.displayId ?? epic.title} — the work below was already running when ` +
          `the Epic was sent back to the backlog, and a run in progress cannot be stopped ` +
          `(D-046). It gets its own Epic so the rest of ${epic.displayId ?? 'the Epic'} could be ` +
          `shelved.*\n\nRename or fold this back in once the run lands.`,
      });
      for (const m of plan.inFlight) {
        await api.updateTicket(m.id, { epicId: spun.id });
      }
      for (const m of plan.pullBack) {
        await api.updateTicket(m.id, { status: 'backlog' });
      }
      await api.updateTicket(epic.id, { status: 'backlog' });
      await load(true);
      showToast(
        `${plan.inFlight.map((m) => m.displayId ?? m.title).join(', ')} moved to ` +
          `${spun.displayId}. ${epic.displayId ?? epic.title} is back in the backlog.`,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      rollbackBusy = false;
    }
  }

  // Start a Refine session (D-044, PD-268), then open the ticket to watch the thread.
  async function refine(ticket: AgentTicket) {
    error = null;
    try {
      await api.startRefine(ticket.id);
      if (ticket.displayId) await goto(`/devops/tickets/${ticket.displayId}`);
      else await load(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(ticket: AgentTicket) {
    // An Epic with members needs the unlink-vs-cascade choice (D-054) — route to the modal.
    if (ticket.isEpic && (epicSummaryById.get(ticket.id)?.total ?? 0) > 0) {
      archiveEpicTarget = ticket;
      return;
    }
    if (!confirm(`Delete "${ticket.title}"?`)) return;
    error = null;
    try {
      await api.deleteTicket(ticket.id);
      await load(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Epic archive-confirm (D-054): archive the Epic only (unlink members) or Epic + all members.
  let archiveEpicTarget = $state<AgentTicket | null>(null);
  const archiveEpicMemberCount = $derived(
    archiveEpicTarget ? (epicSummaryById.get(archiveEpicTarget.id)?.total ?? 0) : 0,
  );
  const archiveEpicActiveCount = $derived(
    archiveEpicTarget
      ? tickets.filter(
          (t) => t.epicId === archiveEpicTarget!.id && (t.status === 'backlog' || t.status === 'queue'),
        ).length
      : 0,
  );

  async function archiveEpic(cascadeMembers: boolean) {
    const target = archiveEpicTarget;
    if (!target) return;
    archiveEpicTarget = null;
    error = null;
    try {
      await api.deleteTicket(target.id, { cascadeMembers });
      await load(true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /* ── Spin off into a new Epic (D-080 slice C) ──────────────────
     The Epic is the unit of priority and dispatch, so a Ticket that must be scheduled apart from
     its siblings needs its own Epic rather than a different rank inside the current one. */
  let spinOffTarget = $state<AgentTicket | null>(null);
  let spinOffBusy = $state(false);
  const spinOffSourceEpic = $derived(
    spinOffTarget?.epicId != null ? ticketsById.get(spinOffTarget.epicId) : undefined,
  );
  const spinOffPlan = $derived<SpinOffPlan>(
    spinOffTarget
      ? planSpinOff(spinOffTarget, spinOffSourceEpic)
      : { title: '', priority: null, status: 'backlog', inheritedFrom: 'ticket' },
  );

  function openSpinOff(ticket: AgentTicket) {
    spinOffTarget = ticket;
  }

  async function confirmSpinOff(title: string) {
    const ticket = spinOffTarget;
    const plan = spinOffPlan;
    if (!ticket || ticket.projectId === null) return;
    error = null;
    spinOffBusy = true;
    try {
      const epic = await api.createTicket({
        title: title.trim(),
        projectId: ticket.projectId,
        priority: plan.priority,
        status: plan.status,
        isEpic: true,
        body: `*Spun off from ${ticket.displayId ?? ticket.title}.*`,
      });
      await api.updateTicket(ticket.id, { epicId: epic.id });
      spinOffTarget = null;
      await load(true);
      showToast(`${ticket.displayId ?? ticket.title} now leads Epic ${epic.displayId}.`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      spinOffBusy = false;
    }
  }

  async function copyIssue(ticket: AgentTicket, project: AgentProject | undefined) {
    const text = buildCopyText(ticket, project);
    try {
      await copyToClipboard(text);
      showToast('Copied to clipboard.');
    } catch {
      showToast('Failed to copy.');
    }
  }
</script>

<section class="tickets-section">
  <BoardToolbar
    bind:search
    bind:filterType
    bind:filterPriority
    bind:filterRefine
    {filterProjectId}
    {filterAssignee}
    {projects}
    columns={COLUMNS}
    {hiddenLanes}
    addDisabled={projects.length === 0}
    shortcutsEnabled={!formOpen && !glossaryOpen}
    onProjectFilter={(id) => (filterProjectId = id)}
    onAssigneeFilter={setAssigneeFilter}
    onToggleLane={toggleLane}
    onOpenGlossary={() => { glossaryTab = 'priority'; glossaryOpen = true; }}
    onAdd={() => openAdd()}
  />

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<TicketFormModal
  open={formOpen}
  {form}
  editing={editingId !== null}
  locked={editingLocked}
  statusDerived={editingEpicWithMembers}
  {projects}
  {epicOptions}
  columns={COLUMNS}
  requireEpic={formRequiresEpic}
  onClose={closeForm}
  onSubmit={submitForm}
/>

<GlossaryModal
  open={glossaryOpen}
  tab={glossaryTab}
  highlightState={glossaryHighlightState}
  onClose={() => (glossaryOpen = false)}
/>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <!-- Two-band board (D-054, amended by D-080): the Epic band on top, the Ticket band
       below. Both are drop targets — dragging the Epic between Backlog and Queue is what
       dispatches and recalls its members. The Epic band's terminal lanes stay derived and refuse
       a drop.

       PD-554: the grid, lane headers and ticket drag now live in `TicketBoard`, shared with the
       Epic detail page. The Epic band stays here — it is this page's alone, and a snippet is
       styled by the component it is written in, so its rules stay in this stylesheet. -->
  <TicketBoard
    columns={visibleColumns}
    itemsFor={byStatus}
    lanes={visibleColumns.length}
    {showEpics}
    {showTickets}
    {epicAreaHeight}
    addDisabled={projects.length === 0}
    onAdd={(status) => openAdd(status)}
    canDrag={(t) => {
      // D-083: terminal is final. Leaving it is one deliberate act on the detail page, not
      // a drag — `completed` is a record of what happened, and a record you can drag out of is
      // not one.
      if (isTerminal(t)) {
        showToast(`${t.displayId ?? t.title} is ${t.status} — open it and use Reopen to bring it back.`);
        return { ok: false };
      }
      if (isStatusLocked(t)) {
        showToast("This ticket is agent-controlled and can't be moved.");
        return { ok: false };
      }
      return { ok: true };
    }}
    onMove={onBoardMove}
    epicBand={epicBandSnippet}
    card={ticketCardSnippet}
  />
{/if}
</section>

{#snippet ticketCardSnippet(ticket: AgentTicket, drag: { dragging: boolean; dropBefore: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void })}
  {@const project = ticket.projectId !== null ? projectsById.get(ticket.projectId) : undefined}
  <TicketCard
    {ticket}
    {project}
    epic={ticket.epicId !== null ? ticketsById.get(ticket.epicId) : undefined}
    dragging={drag.dragging}
    dropBefore={drag.dropBefore}
    isLocked={isStatusLocked(ticket)}
    isFrozen={isTerminal(ticket)}
    badges={badgesById.get(ticket.id) ?? NO_BADGES}
    onRelationAction={(action) => openRelationPicker(ticket, action)}
    onAddToEpic={() => openEpicPicker(ticket)}
    onSpinOff={() => openSpinOff(ticket)}
    onDragStart={drag.onDragStart}
    onDragEnd={drag.onDragEnd}
    onEdit={() => openEdit(ticket)}
    onDuplicate={() => duplicate(ticket)}
    onCopy={() => copyIssue(ticket, project)}
    onDelete={() => remove(ticket)}
    onRefine={() => refine(ticket)}
    onOpenStatusLegend={(state) => {
      glossaryHighlightState = state;
      glossaryTab = 'robot';
      glossaryOpen = true;
    }}
    onUpdate={() => load(true)}
  />
{/snippet}

{#snippet epicBandSnippet()}
      {#each epicBandCells as cell (cell.lane)}
        <EpicLane
          {cell}
          dragOver={epicDropTarget?.lane === cell.lane && epicDraggingId !== null}
          addDisabled={projects.length === 0}
          onAdd={() => openAddEpic('backlog')}
          onDragOver={(e) => onEpicCellDragOver(e, cell)}
          onDrop={(e) => onEpicDrop(e, cell)}
        >
          {#each cell.epics as epic (epic.id)}
            {@const project = epic.projectId !== null ? projectsById.get(epic.projectId) : undefined}
            <EpicCard
              {epic}
              {project}
              summary={epicSummaryById.get(epic.id)}
              dragging={epicDraggingId === epic.id}
              dropBefore={epicDropTarget?.lane === cell.lane && epicDropTarget?.beforeId === epic.id}
              onDragStart={(e) => onEpicDragStart(e, epic)}
              onDragEnd={onEpicDragEnd}
              onEdit={() => openEdit(epic)}
              onDelete={() => remove(epic)}
              onUpdate={() => load(true)}
            />
          {/each}
        </EpicLane>
      {/each}
      <!-- Row 3: Resize handle — drag up/down to adjust the Epic area height (D-058) -->
      <div
        class="epic-resize-handle"
        class:resizing
        role="separator"
        aria-label="Drag to resize epic area"
        onpointerdown={onResizeStart}
        onpointermove={onResizeMove}
        onpointerup={onResizeEnd}
        onpointercancel={onResizeEnd}
      ></div>
{/snippet}


<RelationPicker
  open={pickerOpen}
  action={pickerAction}
  source={pickerSource}
  {tickets}
  {relations}
  onClose={() => (pickerOpen = false)}
  onCreated={(message) => {
    showToast(message);
    void load(true);
  }}
/>

<EpicPicker
  open={epicPickerOpen}
  source={epicPickerSource}
  {tickets}
  onClose={() => (epicPickerOpen = false)}
  onPicked={(epicId) => epicPickerSource && setTicketEpic(epicPickerSource.id, epicId)}
/>

<ArchiveEpicModal
  epic={archiveEpicTarget}
  memberCount={archiveEpicMemberCount}
  activeMemberCount={archiveEpicActiveCount}
  onCancel={() => (archiveEpicTarget = null)}
  onArchive={archiveEpic}
/>

<QueueBypassModal
  label={queueConfirm?.label ?? null}
  onCancel={cancelQueueConfirm}
  onConfirm={acceptQueueConfirm}
/>

<SpinOffModal
  ticket={spinOffTarget}
  plan={spinOffPlan}
  sourceEpic={spinOffSourceEpic}
  busy={spinOffBusy}
  onCancel={() => (spinOffTarget = null)}
  onConfirm={confirmSpinOff}
/>

<EpicRollbackModal
  epic={rollbackTarget}
  plan={rollbackPlan}
  busy={rollbackBusy}
  onCancel={() => (rollbackTarget = null)}
  onContinue={confirmRollback}
  onBump={bumpActiveOut}
/>

<style lang="scss" src="./+page.scss"></style>
