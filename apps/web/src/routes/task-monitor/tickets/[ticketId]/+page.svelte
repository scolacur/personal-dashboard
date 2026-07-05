<script lang="ts">
  import { page } from '$app/state';
  import type { AgentProject, AgentTicket, TicketStatus } from '@dashboard/shared';
  import { PRIORITY_LABELS } from '@dashboard/shared';
  import * as api from '../../api';
  import { projectIdColor } from '../../api';

  // The route param is the human-facing display id, e.g. 'PD-173'.
  const ticketId = $derived(page.params.ticketId);

  let ticket = $state<AgentTicket | null>(null);
  let project = $state<AgentProject | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notFound = $state(false);

  const STATUS_LABELS: Record<TicketStatus, string> = {
    backlog: 'Backlog',
    prioritized: 'Prioritized',
    robot_queue: "Robot's Queue",
    steve_queue: "Steve's Queue",
    completed: 'Completed',
    closed: 'Closed',
  };

  // No single-ticket API endpoint yet, so find it in the list (works against the
  // deployed API without a server change). Cheap enough for this board's size.
  async function load(id: string) {
    loading = true;
    error = null;
    notFound = false;
    ticket = null;
    project = null;
    try {
      const [projects, tickets] = await Promise.all([api.fetchProjects(), api.fetchTickets()]);
      const found = tickets.find((t) => t.displayId === id) ?? null;
      if (!found) {
        notFound = true;
        return;
      }
      ticket = found;
      project =
        found.projectId !== null ? (projects.find((p) => p.id === found.projectId) ?? null) : null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (ticketId) load(ticketId);
  });

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }
</script>

<nav class="detail-nav">
  <a href="/task-monitor">← Back to board</a>
</nav>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if notFound}
  <div class="not-found">
    <h1>Ticket not found</h1>
    <p class="muted">No ticket with id <strong>{ticketId}</strong>.</p>
  </div>
{:else if ticket}
  <article class="ticket-detail">
    <header class="detail-head">
      <span class="detail-id">{ticket.displayId}</span>
      <span class="priority priority-{ticket.priority ?? 'none'}">{ticket.priority ?? '—'}</span>
      {#if ticket.priority}
        <span class="priority-name">{PRIORITY_LABELS[ticket.priority]}</span>
      {/if}
      <span class="status-badge">{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
      {#if project}
        <span class="project-chip" style="--chip: {projectIdColor(project)}"
          >{project.name}</span
        >
      {/if}
    </header>

    <h1 class="detail-title">{ticket.title}</h1>

    {#if ticket.body}
      <p class="detail-body">{ticket.body}</p>
    {:else}
      <p class="muted">No description.</p>
    {/if}

    {#if ticket.githubIssueUrl}
      <p>
        <a class="issue-link" href={ticket.githubIssueUrl} target="_blank" rel="noreferrer"
          >GitHub issue #{ticket.githubIssueNumber}</a
        >
      </p>
    {/if}

    <dl class="detail-meta">
      <div><dt>Source</dt><dd>{ticket.source}</dd></div>
      <div><dt>Created</dt><dd>{fmt(ticket.createdAt)}</dd></div>
      <div><dt>Updated</dt><dd>{fmt(ticket.updatedAt)}</dd></div>
    </dl>
  </article>
{/if}

<style lang="scss" src="./+page.scss"></style>
