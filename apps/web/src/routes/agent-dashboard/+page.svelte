<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProject, AgentTicket, TicketPriority, TicketStatus } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import * as api from './api';

  const COLUMNS: { status: TicketStatus; label: string }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'ready', label: 'Ready' },
    { status: 'queued', label: 'Queued' },
    { status: 'in_progress', label: 'In progress' },
    { status: 'in_review', label: 'In review' },
    { status: 'completed', label: 'Completed' },
  ];
  const PRIORITIES: TicketPriority[] = ['low', 'medium', 'high'];

  let tickets = $state<AgentTicket[]>([]);
  let projects = $state<AgentProject[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // null = "All projects"
  let filterProjectId = $state<number | null>(null);

  // Free-text filter over ticket title + body (case-insensitive).
  let search = $state('');

  // Condensed view hides card descriptions to fit more tickets on screen. On by default.
  let condensed = $state(true);

  // Lanes are grouped by priority: high band on top, then medium, then low. A card can
  // only be reordered within its own band and never dragged into another band.
  const PRIORITY_RANK: Record<TicketPriority, number> = { high: 0, medium: 1, low: 2 };

  // Add / edit form state. `editingId === null` while adding.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let formTitle = $state('');
  let formBody = $state('');
  let formPriority = $state<TicketPriority>('medium');
  let formProjectId = $state<number | null>(null);

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));

  function visibleTickets(): AgentTicket[] {
    const q = search.trim().toLowerCase();
    return tickets.filter((t) => {
      if (filterProjectId !== null && t.projectId !== filterProjectId) return false;
      if (q && !`${t.title} ${t.body ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function byStatus(status: TicketStatus): AgentTicket[] {
    return visibleTickets()
      .filter((t) => t.status === status)
      .sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.sortOrder - b.sortOrder,
      );
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
    formTitle = '';
    formBody = '';
    formPriority = 'medium';
    // Default to the active filter, else the first project.
    formProjectId = filterProjectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function openEdit(ticket: AgentTicket) {
    editingId = ticket.id;
    formTitle = ticket.title;
    formBody = ticket.body ?? '';
    formPriority = ticket.priority;
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
        });
      } else {
        await api.updateTicket(editingId, {
          title,
          body: formBody.trim() || null,
          priority: formPriority,
          projectId: formProjectId,
        });
      }
      formOpen = false;
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

  function onDragStart(e: DragEvent, ticket: AgentTicket) {
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
    const rank = PRIORITY_RANK[dragged.priority];
    const cards = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.card')].filter(
      (el) => Number(el.dataset.id) !== draggingId,
    );
    // Find the insertion point among same-priority cards only — the drop is clamped to the band.
    let beforeId: number | null = null;
    for (const el of cards) {
      if (PRIORITY_RANK[el.dataset.priority as TicketPriority] !== rank) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        beforeId = Number(el.dataset.id);
        break;
      }
    }
    // Past the last same-priority card → land at the end of the band, i.e. just before the
    // first lower-priority card (or the lane end if this band is last).
    if (beforeId === null) {
      const nextBand = cards.find((el) => PRIORITY_RANK[el.dataset.priority as TicketPriority] > rank);
      beforeId = nextBand ? Number(nextBand.dataset.id) : null;
    }
    dropTarget = { status, beforeId };
  }

  // sort_order is a REAL column, so we can slot a card between neighbours by averaging their
  // orders (or stepping ±1 past the ends). Computed within the dragged card's priority band so
  // the new order keeps it inside that band.
  function computeSortOrder(
    status: TicketStatus,
    priority: TicketPriority,
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

  // Click the priority chip to cycle low → medium → high → low.
  async function cyclePriority(ticket: AgentTicket) {
    const idx = PRIORITIES.indexOf(ticket.priority);
    const next = PRIORITIES[(idx + 1) % PRIORITIES.length];
    error = null;
    try {
      await api.updateTicket(ticket.id, { priority: next });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
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
      <label class="condensed-toggle" title="Hide descriptions">
        <input type="checkbox" bind:checked={condensed} />
        <span>Condensed</span>
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
      <textarea bind:value={formBody} rows="4" placeholder="Plain-English description (optional)"
      ></textarea>
    </label>
    <label>
      <span>Priority</span>
      <select bind:value={formPriority}>
        {#each PRIORITIES as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
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
              data-id={ticket.id}
              data-priority={ticket.priority}
              draggable="true"
              ondragstart={(e) => onDragStart(e, ticket)}
              ondragend={onDragEnd}
            >
              <div class="card-top">
                <button
                  type="button"
                  class="priority priority-{ticket.priority}"
                  title="Click to change priority"
                  onclick={() => cyclePriority(ticket)}>{ticket.priority}</button
                >
                {#if ticket.githubIssueUrl}
                  <a class="issue-link" href={ticket.githubIssueUrl} target="_blank" rel="noreferrer">
                    #{ticket.githubIssueNumber}
                  </a>
                {/if}
              </div>
              <p class="card-title">{ticket.title}</p>
              {#if ticket.body && !condensed}
                <p class="card-body">{ticket.body}</p>
              {/if}
              {#if project}
                <span
                  class="project-chip"
                  style="--chip: {project.color ?? 'var(--muted)'}"
                  title={project.name}>{project.name}</span
                >
              {/if}
              <div class="card-actions">
                <span class="spacer"></span>
                <button type="button" title="Edit" aria-label="Edit" onclick={() => openEdit(ticket)}
                  >✎</button
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

<style lang="scss" src="./+page.scss"></style>
