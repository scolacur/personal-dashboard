<script lang="ts">
  import { toast } from '$lib/toast-store.svelte';
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
  import LaneColumn from './LaneColumn.svelte';
  import EpicLane from './EpicLane.svelte';
  import ArchiveEpicModal from './ArchiveEpicModal.svelte';
  import QueueBypassModal from './QueueBypassModal.svelte';
  import EpicRollbackModal from './EpicRollbackModal.svelte';
  import { emptyTicketForm, ticketToForm, type TicketFormState } from './ticket-form';
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
  import { isStatusLocked, computeSortOrder, computeOrderWithin, clampEpicHeight } from '../board-logic';

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

  // Lanes group by priority (P0 on top … P5, then unset at the bottom). A card can
  // only be reordered within its own band and never dragged into another band.
  const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, none: 6 };
  function rankOf(p: TicketPriority | null): number {
    return PRIORITY_RANK[p ?? 'none'];
  }
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

  // Create an Epic from the Epic band's `+` (Backlog only, D-TMP-PD383a).
  function openAddEpic(status: TicketStatus) {
    openAdd(status);
    form.isEpic = true;
  }

  function openEdit(ticket: AgentTicket) {
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
    // D-058: editing/creating a not-Ready robot ticket into the Queue needs an explicit bypass ack.
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
    try {
      // An Epic never belongs to another Epic (no nesting, D-054).
      const epicId = form.isEpic ? null : form.epicId;
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
        // set it in a follow-up patch when the human bypassed the not-Ready gate at create time.
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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
  let draggingId = $state<number | null>(null);
  // Where the dragged card would land: `beforeId === null` means append to the end.
  let dropTarget = $state<{ status: TicketStatus; beforeId: number | null } | null>(null);

  // Toast promoted to `$lib/toast.svelte` + `$lib/Toast.svelte` (PD-334) once the shell's
  // membership writes became a second caller. `<Toast />` is mounted in the root layout.
  const showToast = (message: string) => toast.show(message);

  // Queue-bypass confirm (D-058, PD-399): queueing a not-Ready robot ticket pops this modal —
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
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function onDragStart(e: DragEvent, ticket: AgentTicket) {
    if (isStatusLocked(ticket)) {
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'none';
      showToast("This ticket is agent-controlled and can't be moved.");
      return;
    }
    draggingId = ticket.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(ticket.id));
    }
  }

  function onDragEnd() {
    draggingId = null;
    dropTarget = null;
  }

  function onColumnDragOver(e: DragEvent, status: TicketStatus) {
    if (draggingId === null) return;
    const dragged = tickets.find((t) => t.id === draggingId);
    if (!dragged) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rank = rankOf(dragged.priority);
    const cards = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.card')].filter(
      (el) => Number(el.dataset.id) !== draggingId,
    );
    // Find the insertion point among same-priority cards only — the drop is clamped to the band.
    let beforeId: number | null = null;
    for (const el of cards) {
      if (PRIORITY_RANK[el.dataset.priority ?? 'none'] !== rank) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        beforeId = Number(el.dataset.id);
        break;
      }
    }
    // Past the last same-priority card → land at the end of the band, i.e. just before the
    // first lower-priority card (or the lane end if this band is last).
    if (beforeId === null) {
      const nextBand = cards.find((el) => PRIORITY_RANK[el.dataset.priority ?? 'none'] > rank);
      beforeId = nextBand ? Number(nextBand.dataset.id) : null;
    }
    dropTarget = { status, beforeId };
  }

  async function onDrop(e: DragEvent, status: TicketStatus) {
    e.preventDefault();
    const id = draggingId;
    const target = dropTarget;
    draggingId = null;
    dropTarget = null;
    if (id === null) return;
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    const sortOrder = computeSortOrder(byStatus(status), ticket.priority, target?.beforeId ?? null, id);
    // Skip the round-trip if nothing actually changed.
    if (ticket.status === status && ticket.sortOrder === sortOrder) return;
    // D-058: dragging a not-Ready robot ticket into the Queue needs an explicit bypass ack. Defer
    // the move to the confirm modal; confirming sets `readyBypassed` and completes it.
    if (
      status === 'queue' &&
      ticket.status !== 'queue' &&
      ticket.assignee === 'robot' &&
      !ticket.ready &&
      !ticket.readyBypassed
    ) {
      queueConfirm = {
        label: ticket.displayId ?? ticket.title,
        run: () => applyTicketMove(id, { status, sortOrder, readyBypassed: true }),
      };
      return;
    }
    await applyTicketMove(id, { status, sortOrder });
  }

  /* ── Epic drag (D-TMP-PD383a) ──────────────────────────────────────────
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
    const cards = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.epic-card'),
    ].filter((el) => Number(el.dataset.id) !== epicDraggingId);
    let beforeId: number | null = null;
    for (const el of cards) {
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        beforeId = Number(el.dataset.id);
        break;
      }
    }
    epicDropTarget = { lane: cell.lane, beforeId };
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
    if (laneOfEpic(id) === cell.lane) {
      const sortOrder = computeOrderWithin(cell.epics, target?.beforeId ?? null, id);
      if (epic.sortOrder === sortOrder) return;
      await applyEpicPatch(id, { sortOrder });
      return;
    }

    // Across lanes → move the Epic; the server cascades to its members.
    const members = membersOf(id, tickets);
    if (cell.lane === 'in_progress') {
      const plan = planEpicQueue(members);
      await applyEpicPatch(id, { status: 'queue' });
      showToast(queuedToast(epic, plan));
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
      `${count(plan.notReady.length)} not ready for dispatch`,
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
   * the unit of dispatch (D-TMP-PD383a), scheduling the live ticket and the shelved ones
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
  <!-- Two-band board (D-054, amended by D-TMP-PD383a): the Epic band on top, the Ticket band below.
       Both are drop targets now — dragging the Epic between Backlog and Queue is what dispatches
       and recalls its members. The Epic band's terminal lanes stay derived and refuse a drop. -->
  <div class="board" class:no-epics={!showEpics} style="--lanes: {visibleColumns.length}; --epic-area-height: {epicAreaHeight}px">
    <!-- Row 1: lane headers -->
    {#each visibleColumns as col, i (col.status)}
      {@const tItems = byStatus(col.status)}
      <div class="lane-head" style="grid-column: {i + 1}">
        <h2 class="column-head">
          {col.label}<span class="count">{tItems.length}</span>
        </h2>
      </div>
    {/each}

    <!-- Row 2: Epic band (derived placement; In-Progress sits over the Queue column) -->
    {#if showEpics}
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
    {/if}

    <!-- Row 4: Ticket band (the only drop target) -->
    {#if showTickets}
      {#each visibleColumns as col, i (col.status)}
        {@const items = byStatus(col.status)}
        <LaneColumn
          label={col.label}
          count={items.length}
          gridColumn={i + 1}
          dragOver={dropTarget?.status === col.status && draggingId !== null}
          addDisabled={projects.length === 0}
          showDropEnd={draggingId !== null && dropTarget?.status === col.status && dropTarget?.beforeId === null}
          onAdd={() => openAdd(col.status)}
          onDragOver={(e) => onColumnDragOver(e, col.status)}
          onDrop={(e) => onDrop(e, col.status)}
        >
          {#each items as ticket (ticket.id)}
            {@const project = ticket.projectId !== null ? projectsById.get(ticket.projectId) : undefined}
            <TicketCard
              {ticket}
              {project}
              epic={ticket.epicId !== null ? ticketsById.get(ticket.epicId) : undefined}
              dragging={draggingId === ticket.id}
              dropBefore={dropTarget?.status === col.status && dropTarget?.beforeId === ticket.id}
              isLocked={isStatusLocked(ticket)}
              badges={badgesById.get(ticket.id) ?? NO_BADGES}
              onRelationAction={(action) => openRelationPicker(ticket, action)}
              onAddToEpic={() => openEpicPicker(ticket)}
              onRemoveFromEpic={() => setTicketEpic(ticket.id, null)}
              onDragStart={(e) => onDragStart(e, ticket)}
              {onDragEnd}
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
          {/each}
        </LaneColumn>
      {/each}
    {/if}
  </div>
{/if}
</section>

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
  onCancel={() => (archiveEpicTarget = null)}
  onArchive={archiveEpic}
/>

<QueueBypassModal
  label={queueConfirm?.label ?? null}
  onCancel={cancelQueueConfirm}
  onConfirm={acceptQueueConfirm}
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
