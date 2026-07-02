<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProject, AgentTicket, TicketAssignee, TicketPriority, TicketStatus } from '@dashboard/shared';
  import { TICKET_ASSIGNEES, ASSIGNEE_LABELS, TICKET_PRIORITIES, PRIORITY_LABELS, PRIORITY_DESCRIPTIONS } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import GithubMark from '$lib/icons/GithubMark.svelte';
  import * as api from './api';

  const COLUMNS: { status: TicketStatus; label: string }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'ready', label: 'Ready for Robot' },
    { status: 'queued', label: 'Queued for Robot' },
    { status: 'in_progress', label: 'In progress' },
    { status: 'in_review', label: 'In review' },
    { status: 'completed', label: 'Completed' },
  ];

  // Once a ticket is picked up by an agent, its status is controlled externally,
  // so manual editing (field + drag) is locked for these statuses when assigned.
  const AGENT_CONTROLLED: TicketStatus[] = ['queued', 'in_progress', 'in_review', 'completed'];
  function isStatusLocked(t: AgentTicket): boolean {
    return t.assignee === 'robot' && AGENT_CONTROLLED.includes(t.status);
  }

  let tickets = $state<AgentTicket[]>([]);
  let projects = $state<AgentProject[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // null = "All projects"
  let filterProjectId = $state<number | null>(null);

  // Priority filter: 'all' (no filter), 'none' (unset), or a specific P-level.
  let filterPriority = $state<'all' | 'none' | TicketPriority>('all');

  // Free-text filter over ticket title + body (case-insensitive).
  let search = $state('');

  // Condensed view hides card descriptions to fit more tickets on screen. On by default.
  let condensed = $state(true);

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

  // Priority legend modal.
  let legendOpen = $state(false);

  // Add / edit form state. `editingId === null` while adding.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let editingLocked = $state(false);
  let formTitle = $state('');
  let formBody = $state('');
  let formStatus = $state<TicketStatus>('backlog');
  let formPriority = $state<TicketPriority | null>(null);
  let formAssignee = $state<TicketAssignee | null>('steve');
  let formProjectId = $state<number | null>(null);

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));

  // The per-card ID label is colour-coded by project (replaces the old project
  // badge). PD/NSW use theme accent tokens; Core keeps its teal project colour.
  function idColor(project: AgentProject | undefined): string {
    switch (project?.key) {
      case 'PD':
        return 'var(--accent)';
      case 'C':
        return '#0d9488'; // teal — Core
      case 'NSW':
        return 'var(--accent-2)';
      default:
        return 'var(--muted)';
    }
  }

  function visibleTickets(): AgentTicket[] {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (filterProjectId !== null && t.projectId !== filterProjectId) return false;
      if (filterPriority !== 'all' && bandKey(t.priority) !== filterPriority) return false;
      if (q && !`${t.title} ${t.body ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function byStatus(status: TicketStatus): AgentTicket[] {
    return visibleTickets()
      .filter((t) => t.status === status)
      .sort((a, b) => rankOf(a.priority) - rankOf(b.priority) || a.sortOrder - b.sortOrder);
  }

  async function load() {
    loading = true;
    error = null;
    try {
      [projects, tickets] = await Promise.all([api.fetchProjects(), api.fetchTickets()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openAdd() {
    editingId = null;
    editingLocked = false;
    formTitle = '';
    formBody = '';
    formStatus = 'backlog'; // new tickets start in the backlog
    formPriority = null; // unset by default — assigned deliberately
    formAssignee = 'steve'; // default assignee
    // Default to the active filter, else the first project.
    formProjectId = filterProjectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function openEdit(ticket: AgentTicket) {
    editingId = ticket.id;
    editingLocked = isStatusLocked(ticket);
    formTitle = ticket.title;
    formBody = ticket.body ?? '';
    formStatus = ticket.status;
    formPriority = ticket.priority;
    formAssignee = ticket.assignee;
    formProjectId = ticket.projectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function closeForm() {
    formOpen = false;
  }

  async function submitForm() {
    const title = formTitle.trim();
    if (!title || formProjectId === null) return;
    error = null;
    try {
      if (editingId === null) {
        await api.createTicket({
          title,
          projectId: formProjectId,
          body: formBody.trim() || null,
          priority: formPriority,
          status: formStatus,
          assignee: formAssignee,
        });
      } else {
        await api.updateTicket(editingId, {
          title,
          body: formBody.trim() || null,
          priority: formPriority,
          projectId: formProjectId,
          assignee: formAssignee,
          // Don't send status for agent-locked tickets (it's externally controlled).
          ...(editingLocked ? {} : { status: formStatus }),
        });
      }
      formOpen = false;
      await load();
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
        status: 'backlog',
      });
      await load();
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

  // sort_order is a REAL column, so we can slot a card between neighbours by averaging their
  // orders (or stepping ±1 past the ends). Computed within the dragged card's priority band so
  // the new order keeps it inside that band.
  function computeSortOrder(
    status: TicketStatus,
    priority: TicketPriority | null,
    beforeId: number | null,
    draggedId: number,
  ): number {
    const band = byStatus(status).filter((t) => t.priority === priority && t.id !== draggedId);
    // beforeId may point at a card outside the band (the boundary) or be null → append to band end.
    let idx = beforeId === null ? band.length : band.findIndex((t) => t.id === beforeId);
    if (idx === -1) idx = band.length;
    const prev = band[idx - 1];
    const next = band[idx];
    if (!prev && !next) return 0;
    if (!prev) return next.sortOrder - 1;
    if (!next) return prev.sortOrder + 1;
    return (prev.sortOrder + next.sortOrder) / 2;
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
    const sortOrder = computeSortOrder(status, ticket.priority, target?.beforeId ?? null, id);
    // Skip the round-trip if nothing actually changed.
    if (ticket.status === status && ticket.sortOrder === sortOrder) return;
    error = null;
    try {
      await api.updateTicket(id, { status, sortOrder });
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Set a ticket's priority (null = unset) from the in-place dropdown.
  async function setPriority(ticket: AgentTicket, priority: TicketPriority | null) {
    if (ticket.priority === priority) return;
    error = null;
    try {
      await api.updateTicket(ticket.id, { priority });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Set a ticket's assignee from the in-place dropdown.
  async function setAssignee(ticket: AgentTicket, assignee: TicketAssignee | null) {
    if (ticket.assignee === assignee) return;
    error = null;
    try {
      await api.updateTicket(ticket.id, { assignee });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function assigneeLabel(assignee: TicketAssignee | null): string {
    if (assignee === 'steve') return 'S';
    if (assignee === 'robot') return '🤖';
    return '—';
  }

  async function remove(ticket: AgentTicket) {
    if (!confirm(`Delete "${ticket.title}"?`)) return;
    error = null;
    try {
      await api.deleteTicket(ticket.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<header class="page-head">
  <h1>Mission Control</h1>
</header>

<section class="tickets-section">
  <div class="section-head">
    <h2 class="section-title">Tickets</h2>
    <div class="head-controls">
      <label class="ticket-search">
        <span class="sr-label">Search tickets</span>
        <input type="search" bind:value={search} placeholder="Search tickets…" />
      </label>
      <button
        class="info-btn"
        type="button"
        title="Priority levels"
        aria-label="Priority levels"
        onclick={() => (legendOpen = true)}>i</button
      >
      <label class="condensed-toggle" title="Hide descriptions">
        <input type="checkbox" bind:checked={condensed} />
        <span>Condensed</span>
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
      <button class="add-btn" type="button" onclick={openAdd} disabled={projects.length === 0}>
        + Add Ticket
      </button>
    </div>
  </div>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<Modal open={formOpen} title={editingId === null ? 'New Ticket' : 'Edit Ticket'} onClose={closeForm}>
  <div class="ticket-form">
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
      <input type="text" bind:value={formTitle} placeholder="What needs doing?" />
    </label>
    <label>
      <span>Details</span>
      <textarea bind:value={formBody} rows="12" placeholder="Plain-English description (optional)"
      ></textarea>
    </label>
    <label>
      <span>Status</span>
      <select bind:value={formStatus} disabled={editingLocked}>
        {#each COLUMNS as c (c.status)}
          <option value={c.status}>{c.label}</option>
        {/each}
      </select>
      {#if editingLocked}
        <small class="field-note">Locked — this ticket is controlled by its agent.</small>
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
      <button type="button" class="ghost" onclick={closeForm}>Cancel</button>
      <button
        type="button"
        class="primary"
        onclick={submitForm}
        disabled={!formTitle.trim() || formProjectId === null}
      >
        {editingId === null ? 'Add' : 'Save'}
      </button>
    </div>
  </div>
</Modal>

<Modal open={legendOpen} title="Priority levels" onClose={() => (legendOpen = false)}>
  <ul class="priority-legend">
    {#each TICKET_PRIORITIES as p (p)}
      <li>
        <span class="priority priority-{p}">{p}</span>
        <span class="legend-label">{PRIORITY_LABELS[p]}</span>
        <span class="legend-desc">{PRIORITY_DESCRIPTIONS[p]}</span>
      </li>
    {/each}
    <li>
      <span class="priority priority-none">—</span>
      <span class="legend-label">None</span>
      <span class="legend-desc">Priority not set.</span>
    </li>
  </ul>
</Modal>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <div class="board">
    {#each COLUMNS as col (col.status)}
      {@const items = byStatus(col.status)}
      <section class="column" class:drag-over={dropTarget?.status === col.status && draggingId !== null}>
        <h2 class="column-head">
          {col.label}<span class="count">{items.length}</span>
        </h2>
        <div
          class="column-body"
          role="list"
          ondragover={(e) => onColumnDragOver(e, col.status)}
          ondrop={(e) => onDrop(e, col.status)}
        >
          {#each items as ticket (ticket.id)}
            {@const project = ticket.projectId !== null ? projectsById.get(ticket.projectId) : undefined}
            <article
              class="card"
              class:done={ticket.status === 'completed'}
              class:dragging={draggingId === ticket.id}
              class:drop-before={dropTarget?.status === col.status && dropTarget?.beforeId === ticket.id}
              class:locked={isStatusLocked(ticket)}
              data-id={ticket.id}
              data-priority={bandKey(ticket.priority)}
              draggable={true}
              ondragstart={(e) => onDragStart(e, ticket)}
              ondragend={onDragEnd}
            >
              <div class="card-top">
                <div class="card-top-left">
                  <select
                    class="priority priority-{bandKey(ticket.priority)}"
                    title="Set priority"
                    value={ticket.priority ?? ''}
                    onchange={(e) =>
                      setPriority(ticket, (e.currentTarget.value || null) as TicketPriority | null)}
                  >
                    <option value="">—</option>
                    {#each TICKET_PRIORITIES as p (p)}
                      <option value={p}>{p}</option>
                    {/each}
                  </select>
                  <select
                    class="assignee-pill assignee-{ticket.assignee ?? 'none'}"
                    title={isStatusLocked(ticket)
                      ? 'Agent-controlled — cannot reassign'
                      : `Assignee: ${ticket.assignee ? ASSIGNEE_LABELS[ticket.assignee] : 'None'}`}
                    value={ticket.assignee ?? ''}
                    disabled={isStatusLocked(ticket)}
                    onchange={(e) =>
                      setAssignee(ticket, (e.currentTarget.value || null) as TicketAssignee | null)}
                  >
                    <option value="">—</option>
                    {#each TICKET_ASSIGNEES as a (a)}
                      <option value={a}>{assigneeLabel(a)}</option>
                    {/each}
                  </select>
                </div>
                <span class="card-top-right">
                  {#if ticket.githubIssueUrl}
                    <a
                      class="issue-link"
                      href={ticket.githubIssueUrl}
                      target="_blank"
                      rel="noreferrer"
                      draggable="false"
                      title="GitHub issue #{ticket.githubIssueNumber}"
                      aria-label="GitHub issue #{ticket.githubIssueNumber}"
                    >
                      <GithubMark size={14} />
                    </a>
                  {/if}
                  {#if ticket.displayId}
                    <a
                      class="ticket-id"
                      style="--id-color: {idColor(project)}"
                      href="/agent-dashboard/tickets/{ticket.displayId}"
                      title={project ? `${project.name} · open ${ticket.displayId}` : `Open ${ticket.displayId}`}
                      draggable="false">{ticket.displayId}</a
                    >
                  {/if}
                </span>
              </div>
              <p class="card-title">{ticket.title}</p>
              {#if ticket.body && !condensed}
                <p class="card-body">{ticket.body}</p>
              {/if}
              <div class="card-actions">
                <span class="spacer"></span>
                <button type="button" title="Edit" aria-label="Edit" onclick={() => openEdit(ticket)}
                  >✎</button
                >
                <button
                  type="button"
                  title="Duplicate"
                  aria-label="Duplicate"
                  onclick={() => duplicate(ticket)}>⧉</button
                >
                <button
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  onclick={() => remove(ticket)}>🗑</button
                >
              </div>
            </article>
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
  </div>
{/if}
</section>

{#if toast}
  <div class="toast" role="status">{toast}</div>
{/if}

<style lang="scss" src="./+page.scss"></style>
