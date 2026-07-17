<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import DeployStatus from '../DeployStatus.svelte';
  import SystemStatus from './SystemStatus.svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AgentProject, AgentState, AgentTicket, TicketAssignee, TicketPriority, TicketStatus, TicketRelation, EpicSummary, EpicDerivedLane, UpdateTicketInput } from '@dashboard/shared';
  import { TICKET_ASSIGNEES, ASSIGNEE_LABELS, TICKET_PRIORITIES, PRIORITY_LABELS, isReady } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import GlossaryModal from '$lib/GlossaryModal.svelte';
  import TicketCard from './TicketCard.svelte';
  import EpicCard from './EpicCard.svelte';
  import RelationPicker from './RelationPicker.svelte';
  import EpicPicker from './EpicPicker.svelte';
  import { computeBadges, type RelationAction, type RelationBadges } from './relation-logic';
  import { buildEpicBand, type EpicBandCell } from './epic-logic';
  import JobsList from './JobsList.svelte';
  import * as api from './api';
  import { ticketMatchesQuery, ticketMatchesRefineFilter, ticketMatchesAssigneeFilter } from './filter-logic';
  import type { RefineFilter, AssigneeFilter } from './filter-logic';
  import { compareTicketsInColumn } from './sort-logic';
  import { buildCopyText, copyToClipboard } from './copy-utils';
  import { isStatusLocked, computeSortOrder, computeOrderWithin, clampEpicHeight } from './board-logic';
  import Button from '$lib/Button.svelte';

  const COLUMNS: { status: TicketStatus; label: string; defaultHidden?: boolean }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'prioritized', label: 'Prioritized' },
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

  let laneMenuOpen = $state(false);
  let laneMenuRef = $state<HTMLElement | null>(null);
  let searchInputRef = $state<HTMLInputElement | null>(null);

  function toggleLane(status: TicketStatus) {
    if (hiddenLanes.has(status)) {
      hiddenLanes.delete(status);
    } else {
      hiddenLanes.add(status);
    }
    saveLaneVisibility(hiddenLanes);
  }

  function handleWindowClick(e: MouseEvent) {
    if (laneMenuOpen && laneMenuRef && !laneMenuRef.contains(e.target as Node)) {
      laneMenuOpen = false;
    }
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.metaKey && e.key === 'k' && !formOpen && !glossaryOpen) {
      e.preventDefault();
      if (document.activeElement === searchInputRef) {
        searchInputRef?.blur();
      } else {
        searchInputRef?.focus();
        searchInputRef?.select();
      }
    }
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


  // Add / edit form state. `editingId === null` while adding.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let editingLocked = $state(false);
  let formTitle = $state('');
  let formBody = $state('');
  let formStatus = $state<TicketStatus>('backlog');
  let formPriority = $state<TicketPriority | null>(null);
  let formAssignee = $state<TicketAssignee | null>(null);
  // Whether the add form is creating an Epic (D-054). The board's Epic `+` sets this; the
  // Is-Epic checkbox toggles it in the form (PD-338).
  let formIsEpic = $state(false);
  // Which Epic this ticket belongs to (D-054, PD-338); null = none. Forced null when isEpic.
  let formEpicId = $state<number | null>(null);
  let formProjectId = $state<number | null>(null);

  // Epics selectable as a parent in the form's "Belongs to epic" dropdown — same project,
  // excluding the ticket being edited (no nesting / self).
  const epicOptions = $derived(
    tickets.filter((t) => t.isEpic && t.projectId === formProjectId && t.id !== editingId),
  );

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));

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
  // setting it here silently no-ops. Lock the Status field for that case and explain why.
  const editingEpicWithMembers = $derived(
    editingId !== null &&
      formIsEpic &&
      (epicSummaryById.get(editingId)?.total ?? 0) > 0,
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
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('keydown', handleWindowKeydown);
    // Background auto-refresh every 30 s. Reads the DB only; the server cron keeps it fresh
    // for idle tabs.
    const refreshTimer = setInterval(() => load(true), 30_000);
    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('keydown', handleWindowKeydown);
      clearInterval(refreshTimer);
    };
  });

  function openAdd(status: TicketStatus = 'backlog') {
    editingId = null;
    editingLocked = false;
    formTitle = '';
    formBody = '';
    formStatus = status;
    formPriority = null; // unset by default — assigned deliberately
    formAssignee = null;
    formIsEpic = false;
    formEpicId = null;
    // Default to the active filter, else "personal-dashboard", else the first project.
    const personalDashboard = projects.find((p) => p.slug === 'personal-dashboard');
    formProjectId = filterProjectId ?? personalDashboard?.id ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  // Create an Epic from the Epic band's `+` (Backlog/Prioritized only, D-054).
  function openAddEpic(status: TicketStatus) {
    openAdd(status);
    formIsEpic = true;
  }

  function openEdit(ticket: AgentTicket) {
    editingId = ticket.id;
    editingLocked = isStatusLocked(ticket);
    formTitle = ticket.title;
    formBody = ticket.body ?? '';
    formStatus = ticket.status;
    formPriority = ticket.priority;
    formAssignee = ticket.assignee;
    formIsEpic = ticket.isEpic;
    formEpicId = ticket.epicId;
    formProjectId = ticket.projectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function closeForm() {
    formOpen = false;
  }

  async function submitForm() {
    const title = formTitle.trim();
    if (!title || formProjectId === null) return;
    // D-058: editing/creating a not-Ready robot ticket into the Queue needs an explicit bypass ack.
    // Skip the prompt for a ticket that's already bypassed (editing it shouldn't re-ask) and for an
    // agent-locked ticket (its status isn't sent). Confirm sets `readyBypassed`; cancel aborts.
    const existing = editingId !== null ? tickets.find((t) => t.id === editingId) : undefined;
    const needsBypass =
      formStatus === 'queue' &&
      formAssignee === 'robot' &&
      !isReady(formBody.trim() || null) &&
      !(existing?.readyBypassed ?? false) &&
      !(editingId !== null && editingLocked);
    if (needsBypass) {
      queueConfirm = { label: title, run: () => writeForm(true) };
      return;
    }
    await writeForm(false);
  }

  async function writeForm(bypass: boolean) {
    const title = formTitle.trim();
    if (!title || formProjectId === null) return;
    error = null;
    try {
      // An Epic never belongs to another Epic (no nesting, D-054).
      const epicId = formIsEpic ? null : formEpicId;
      if (editingId === null) {
        const created = await api.createTicket({
          title,
          projectId: formProjectId,
          body: formBody.trim() || null,
          priority: formPriority,
          status: formStatus,
          assignee: formAssignee,
          isEpic: formIsEpic,
          epicId,
        });
        // CreateTicketInput carries no `readyBypassed` (backend enum/guards are ticket A's scope) —
        // set it in a follow-up patch when the human bypassed the not-Ready gate at create time.
        if (bypass) await api.updateTicket(created.id, { readyBypassed: true });
      } else {
        await api.updateTicket(editingId, {
          title,
          body: formBody.trim() || null,
          priority: formPriority,
          projectId: formProjectId,
          assignee: formAssignee,
          isEpic: formIsEpic,
          epicId,
          // Don't send status for agent-locked tickets (it's externally controlled).
          ...(editingLocked ? {} : { status: formStatus }),
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

  // Auto-dismissing toast message.
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(message: string) {
    toast = message;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast = null;
      toastTimer = null;
    }, 3000);
  }

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

  /* ── Epic reorder (D-054 amended) ──────────────────────────────────────
     Epics reorder WITHIN their derived lane only — lane placement stays derived
     (never dragged across lanes / into a queue); this just sets `sortOrder` among
     the cell's epics. Separate drag state from tickets so the two bands don't cross-react. */
  let epicDraggingId = $state<number | null>(null);
  let epicDropTarget = $state<{ lane: EpicDerivedLane; beforeId: number | null } | null>(null);

  function onEpicDragStart(e: DragEvent, epic: AgentTicket) {
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
    // Only allow reordering within the epic's own lane (lane is derived, not draggable).
    if (epicDraggingId === null || !cell.epics.some((ep) => ep.id === epicDraggingId)) return;
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
    if (id === null || !cell.epics.some((ep) => ep.id === id)) return; // same-lane only
    const epic = tickets.find((t) => t.id === id);
    if (!epic) return;
    const sortOrder = computeOrderWithin(cell.epics, target?.beforeId ?? null, id);
    if (epic.sortOrder === sortOrder) return;
    error = null;
    try {
      await api.updateTicket(id, { sortOrder });
      await load(true);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Start a Refine session (D-044, PD-268), then open the ticket to watch the thread.
  async function refine(ticket: AgentTicket) {
    error = null;
    try {
      await api.startRefine(ticket.id);
      if (ticket.displayId) await goto(`/task-monitor/tickets/${ticket.displayId}`);
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

<section class="deploy-section" id="site-status">
  <div class="section-head">
    <h2 class="section-title">Site Status</h2>
  </div>
  <DeployStatus />
  <SystemStatus />
</section>

<JobsList heading="Jobs" limit={5} viewAllHref="/task-monitor/jobs" />

<section class="tickets-section" id="tickets">
  <div class="section-head">
    <h2 class="section-title">Tickets</h2>
    <label class="ticket-search" class:has-text={search !== ''}>
      <span class="sr-label">Search tickets</span>
      <input type="search" bind:value={search} bind:this={searchInputRef} placeholder="Search tickets…" />
      {#if search}
        <button
          type="button"
          class="search-clear"
          aria-label="Clear search"
          onclick={() => { search = ''; searchInputRef?.focus(); }}
        >×</button>
      {/if}
      <span class="search-hint" aria-hidden="true"><kbd>⌘K</kbd></span>
    </label>
    <div class="head-actions">
      <Button
        variant="ghost"
        title="Glossary"
        onclick={() => { glossaryTab = 'priority'; glossaryOpen = true; }}
      >Glossary</Button>
      <div class="lanes-menu-wrap" bind:this={laneMenuRef}>
        <Button
          variant="ghost"
          title="Show/hide lanes"
          aria-label="Show/hide lanes"
          aria-expanded={laneMenuOpen}
          onclick={() => (laneMenuOpen = !laneMenuOpen)}
        >Lanes</Button>
        {#if laneMenuOpen}
          <div class="lanes-menu">
            {#each COLUMNS as col (col.status)}
              <label class="lanes-menu-item">
                <input
                  type="checkbox"
                  checked={!hiddenLanes.has(col.status)}
                  onchange={() => toggleLane(col.status)}
                />
                <span>{col.label}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
      <div class="add-ticket-wrap">
        <Button variant="primary" onclick={() => openAdd()} disabled={projects.length === 0}>
          + Add Ticket
        </Button>
      </div>
    </div>
  </div>

  <!-- Second toolbar row: all filters (D-054 adds Ticket Type). Search + buttons stay on row 1. -->
  <div class="filters-row">
    <label class="type-filter">
      <span class="sr-label">Type</span>
      <select bind:value={filterType}>
        <option value="all">Epics &amp; Tickets</option>
        <option value="epics-lone">Epics &amp; Lone Tickets</option>
        <option value="epics">Epics only</option>
        <option value="tickets">Tickets only</option>
      </select>
    </label>
    <label class="project-filter">
      <span class="sr-label">Project</span>
      <select
        value={filterProjectId === null ? 'all' : String(filterProjectId)}
        onchange={(e) => {
          const v = e.currentTarget.value;
          filterProjectId = v === 'all' ? null : Number(v);
        }}
      >
        <option value="all">All projects</option>
        {#each projects as p (p.id)}
          <option value={String(p.id)}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label class="priority-filter">
      <span class="sr-label">Priority</span>
      <select bind:value={filterPriority}>
        <option value="all">All priorities</option>
        {#each TICKET_PRIORITIES as p (p)}
          <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
        {/each}
        <option value="none">— None</option>
      </select>
    </label>
    <label class="assignee-filter">
      <span class="sr-label">Assignee</span>
      <select
        value={filterAssignee}
        onchange={(e) => setAssigneeFilter(e.currentTarget.value as AssigneeFilter)}
      >
        <option value="all">All assignees</option>
        <option value="robot">🤖 Robot</option>
        <option value="steve">S Steve</option>
        <option value="none">— Unassigned</option>
      </select>
    </label>
    <label class="refinement-filter">
      <span class="sr-label">Refinement</span>
      <select bind:value={filterRefine}>
        <option value="all">All refinement statuses</option>
        <option value="refined">Refined</option>
        <option value="refining">Refining</option>
        <option value="awaiting-human">Needs you</option>
        <option value="unrefined">Unrefined</option>
      </select>
    </label>
  </div>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<Modal open={formOpen} title={editingId === null ? 'New Ticket' : 'Edit Ticket'} onClose={closeForm}>
  <div class="ticket-form">
    <label class="epic-flag">
      <input type="checkbox" bind:checked={formIsEpic} />
      This is an Epic (an umbrella for other tickets)
    </label>
    {#if !formIsEpic}
      <label>
        <span>Belongs to epic</span>
        <select
          value={formEpicId === null ? '' : String(formEpicId)}
          onchange={(e) => {
            const v = e.currentTarget.value;
            formEpicId = v === '' ? null : Number(v);
          }}
        >
          <option value="">— None</option>
          {#each epicOptions as ep (ep.id)}
            <option value={String(ep.id)}>{ep.displayId} — {ep.title}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label>
      <span>Project</span>
      <select bind:value={formProjectId}>
        {#each projects as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Title</span>
      <input type="text" bind:value={formTitle} />
    </label>
    <label>
      <span>Details</span>
      <textarea bind:value={formBody} rows="12"></textarea>
    </label>
    <label>
      <span>Status</span>
      <select bind:value={formStatus} disabled={editingLocked || editingEpicWithMembers}>
        {#each COLUMNS as c (c.status)}
          <option value={c.status}>{c.label}</option>
        {/each}
      </select>
      {#if editingLocked}
        <small class="field-note">Locked — this ticket is controlled by its agent.</small>
      {:else if editingEpicWithMembers}
        <small class="field-note">Derived from members — prioritize a member to move the Epic.</small>
      {/if}
    </label>
    <label>
      <span>Priority</span>
      <select bind:value={formPriority}>
        <option value={null}>— None</option>
        {#each TICKET_PRIORITIES as p (p)}
          <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Assignee</span>
      <select bind:value={formAssignee} disabled={editingLocked}>
        <option value={null}>— None</option>
        {#each TICKET_ASSIGNEES as a (a)}
          <option value={a}>{ASSIGNEE_LABELS[a]}</option>
        {/each}
      </select>
      {#if editingLocked}
        <small class="field-note">Locked — controlled by its agent.</small>
      {/if}
    </label>
    <div class="form-actions">
      <Button variant="ghost" onclick={closeForm}>Cancel</Button>
      <Button
        variant="primary"
        onclick={submitForm}
        disabled={!formTitle.trim() || formProjectId === null}
      >
        {editingId === null ? 'Add' : 'Save'}
      </Button>
    </div>
  </div>
</Modal>

<GlossaryModal
  open={glossaryOpen}
  tab={glossaryTab}
  highlightState={glossaryHighlightState}
  onClose={() => (glossaryOpen = false)}
/>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <!-- Two-band board (D-054): a derived, non-draggable Epic band on top; the normal Ticket band
       below. Only the Ticket band is a drop target, so an Epic can never enter Robot's Queue. -->
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

    <!-- Row 2: Epic band (derived placement; In-Progress spans the two queue columns) -->
    {#if showEpics}
      {#each epicBandCells as cell (cell.lane)}
        <div
          class="epic-cell"
          class:in-progress={cell.lane === 'in_progress'}
          class:drag-over={epicDropTarget?.lane === cell.lane && epicDraggingId !== null}
          style="grid-column: {cell.colStart} / span {cell.colSpan}"
          ondragover={(e) => onEpicCellDragOver(e, cell)}
          ondrop={(e) => onEpicDrop(e, cell)}
          role="list"
        >
          {#if cell.canAdd}
            <button
              class="column-add-btn epic-add"
              type="button"
              title="Add Epic to {cell.label}"
              aria-label="Add Epic to {cell.label}"
              onclick={() => openAddEpic(cell.lane === 'backlog' ? 'backlog' : 'prioritized')}
              disabled={projects.length === 0}
            >+ Epic</button>
          {/if}
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
        </div>
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

    <!-- Row 3: Ticket band (the only drop target) -->
    {#if showTickets}
      {#each visibleColumns as col, i (col.status)}
        {@const items = byStatus(col.status)}
        <section
          class="ticket-cell"
          class:robot-queue={col.status === 'queue'}
          class:drag-over={dropTarget?.status === col.status && draggingId !== null}
          style="grid-column: {i + 1}"
        >
          <button
            class="column-add-btn"
            type="button"
            title="Add ticket to {col.label}"
            aria-label="Add ticket to {col.label}"
            onclick={() => openAdd(col.status)}
            disabled={projects.length === 0}
          >+</button>
          <div
            class="column-body"
            role="list"
            ondragover={(e) => onColumnDragOver(e, col.status)}
            ondrop={(e) => onDrop(e, col.status)}
          >
            {#each items as ticket (ticket.id)}
              {@const project = ticket.projectId !== null ? projectsById.get(ticket.projectId) : undefined}
              <TicketCard
                {ticket}
                {project}
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
            {#if draggingId !== null && dropTarget?.status === col.status && dropTarget?.beforeId === null}
              <div class="drop-end"></div>
            {/if}
            {#if items.length === 0}
              <p class="empty">—</p>
            {/if}
          </div>
        </section>
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

<Modal
  open={archiveEpicTarget !== null}
  title="Archive Epic"
  onClose={() => (archiveEpicTarget = null)}
>
  {#if archiveEpicTarget}
    <p class="archive-epic-msg">
      <strong>{archiveEpicTarget.displayId ?? archiveEpicTarget.title}</strong> has
      {archiveEpicMemberCount} member{archiveEpicMemberCount === 1 ? '' : 's'}. Archive the Epic
      only (its members become free tickets), or archive the Epic and all its members?
    </p>
    <div class="archive-epic-actions">
      <Button variant="ghost" onclick={() => (archiveEpicTarget = null)}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="ghost" onclick={() => archiveEpic(false)}>Epic only (unlink members)</Button>
      <Button variant="primary" onclick={() => archiveEpic(true)}>
        Epic + {archiveEpicMemberCount} member{archiveEpicMemberCount === 1 ? '' : 's'}
      </Button>
    </div>
  {/if}
</Modal>

<Modal
  open={queueConfirm !== null}
  title="Queue a not-Ready ticket?"
  onClose={cancelQueueConfirm}
>
  {#if queueConfirm}
    <p class="queue-confirm-msg">
      <strong>{queueConfirm.label}</strong> isn't in Ready shape — its body is missing the four
      sections (## Context / ## Task / ## Done When / ## Out of scope). The Robot works best from a
      shaped ticket, so <strong>output may be suboptimal</strong>. Queue it anyway?
    </p>
    <div class="queue-confirm-actions">
      <Button variant="ghost" onclick={cancelQueueConfirm}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="primary" onclick={acceptQueueConfirm}>Queue anyway</Button>
    </div>
  {/if}
</Modal>

{#if toast}
  <div class="toast" role="status">{toast}</div>
{/if}

<style lang="scss" src="./+page.scss"></style>
