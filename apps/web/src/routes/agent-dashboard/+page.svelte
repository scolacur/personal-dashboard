<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProject, AgentTicket, TicketPriority, TicketStatus } from '@dashboard/shared';
  import { TICKET_STATUSES } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import * as api from './api';

  const COLUMNS: { status: TicketStatus; label: string }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'ready', label: 'Ready' },
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

  // Add / edit form state. `editingId === null` while adding.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let formTitle = $state('');
  let formBody = $state('');
  let formPriority = $state<TicketPriority>('medium');
  let formProjectId = $state<number | null>(null);

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));

  function visibleTickets(): AgentTicket[] {
    return filterProjectId === null ? tickets : tickets.filter((t) => t.projectId === filterProjectId);
  }

  function byStatus(status: TicketStatus): AgentTicket[] {
    return visibleTickets().filter((t) => t.status === status);
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

  async function move(ticket: AgentTicket, delta: number) {
    const idx = TICKET_STATUSES.indexOf(ticket.status);
    const next = TICKET_STATUSES[idx + delta];
    if (!next) return;
    error = null;
    try {
      // Append to the end of the destination column.
      await api.updateTicket(ticket.id, { status: next, sortOrder: Date.now() });
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

  function canMoveLeft(ticket: AgentTicket): boolean {
    return TICKET_STATUSES.indexOf(ticket.status) > 0;
  }
  function canMoveRight(ticket: AgentTicket): boolean {
    return TICKET_STATUSES.indexOf(ticket.status) < TICKET_STATUSES.length - 1;
  }
</script>

<header class="page-head">
  <h1>Mission Control</h1>
  <div class="head-controls">
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
</header>

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
      <section class="column">
        <h2 class="column-head">
          {col.label}<span class="count">{items.length}</span>
        </h2>
        <div class="column-body">
          {#each items as ticket (ticket.id)}
            {@const project = ticket.projectId !== null ? projectsById.get(ticket.projectId) : undefined}
            <article class="card" class:done={ticket.status === 'completed'}>
              <div class="card-top">
                <span class="priority priority-{ticket.priority}">{ticket.priority}</span>
                {#if ticket.githubIssueUrl}
                  <a class="issue-link" href={ticket.githubIssueUrl} target="_blank" rel="noreferrer">
                    #{ticket.githubIssueNumber}
                  </a>
                {/if}
              </div>
              <p class="card-title">{ticket.title}</p>
              {#if ticket.body}
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
                <button
                  type="button"
                  title="Move left"
                  aria-label="Move left"
                  disabled={!canMoveLeft(ticket)}
                  onclick={() => move(ticket, -1)}>◀</button
                >
                <button
                  type="button"
                  title="Move right"
                  aria-label="Move right"
                  disabled={!canMoveRight(ticket)}
                  onclick={() => move(ticket, 1)}>▶</button
                >
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
          {#if items.length === 0}
            <p class="empty">—</p>
          {/if}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style lang="scss" src="./+page.scss"></style>
