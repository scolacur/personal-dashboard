<script lang="ts">
  import { page } from '$app/state';
  import type { AgentProject, AgentTicket, TicketLineage, TicketStatus } from '@dashboard/shared';
  import { PRIORITY_LABELS } from '@dashboard/shared';
  import * as api from '../../api';
  import { projectIdColor } from '../../api';
  import TicketThread from '$lib/TicketThread.svelte';

  // The route param is the human-facing display id, e.g. 'PD-173'.
  const ticketId = $derived(page.params.ticketId);

  let ticket = $state<AgentTicket | null>(null);
  let project = $state<AgentProject | null>(null);
  let lineage = $state<TicketLineage | null>(null);
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
      lineage = await api.fetchLineage(found.id);
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

  // PD-250 inline reply: shown when the agent has parked for input on a linked issue.
  let replyText = $state('');
  let replying = $state(false);
  let replyMsg = $state<string | null>(null);

  const isParked = $derived(
    ticket?.agentState === 'awaiting-human' || ticket?.agentState === 'needs-human',
  );

  async function submitReply() {
    if (!ticket || !replyText.trim()) return;
    replying = true;
    replyMsg = null;
    try {
      await api.replyToTicket(ticket.id, replyText.trim());
      replyMsg = 'Reply sent — the agent will resume shortly.';
      replyText = '';
    } catch (e) {
      replyMsg = e instanceof Error ? e.message : String(e);
    } finally {
      replying = false;
    }
  }

  // Start a Refine session (D-044, PD-268) from the detail page. The TicketThread below
  // polls, so the kickoff turn appears shortly after; reload to flip refineState now.
  let starting = $state(false);
  async function startRefine() {
    if (!ticket || starting || !ticketId) return;
    starting = true;
    error = null;
    try {
      await api.startRefine(ticket.id);
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  }

  // Mark the ticket refined (D-044, PD-268). PD-269's commit step will also set this; until
  // then it's a manual "I'm satisfied with this refinement" action.
  let markingRefined = $state(false);
  async function markRefined() {
    if (!ticket || markingRefined || !ticketId) return;
    markingRefined = true;
    error = null;
    try {
      await api.updateTicket(ticket.id, { refined: true });
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      markingRefined = false;
    }
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

    {#if isParked && ticket.githubIssueNumber}
      <section class="reply-box">
        <h2>Reply to the agent</h2>
        <p class="muted">
          The agent paused ({ticket.agentState?.replace(/-/g, ' ')}) and needs your input. Your
          reply is posted to the issue and re-queues it.
        </p>
        <textarea
          bind:value={replyText}
          rows="4"
          placeholder="Type your answer…"
          disabled={replying}
        ></textarea>
        <div class="reply-actions">
          <button onclick={submitReply} disabled={replying || !replyText.trim()}>
            {replying ? 'Sending…' : 'Send reply'}
          </button>
          {#if replyMsg}<span class="reply-msg">{replyMsg}</span>{/if}
        </div>
      </section>
    {/if}

    <dl class="detail-meta">
      <div><dt>Source</dt><dd>{ticket.source}</dd></div>
      <div><dt>Created</dt><dd>{fmt(ticket.createdAt)}</dd></div>
      <div><dt>Updated</dt><dd>{fmt(ticket.updatedAt)}</dd></div>
    </dl>

    <div class="refine-controls">
      {#if ticket.refined}
        <span class="refined-badge" title="This ticket has been refined">✓ Refined</span>
      {:else if ticket.refineState === null}
        <button class="start-refine" type="button" onclick={startRefine} disabled={starting}>
          {starting ? 'Starting…' : '✦ Start Refine'}
        </button>
      {:else}
        <button class="mark-refined" type="button" onclick={markRefined} disabled={markingRefined}>
          {markingRefined ? 'Marking…' : '✓ Mark refined'}
        </button>
      {/if}
    </div>

    {#if lineage && (lineage.splitInto.length > 0 || lineage.splitFrom.length > 0)}
      <section class="lineage">
        <h2>Lineage</h2>
        {#if lineage.splitFrom.length > 0}
          <p class="lineage-group">
            <span class="lineage-label">Split from</span>
            {#each lineage.splitFrom as ref (ref.ticketId)}
              <a class="lineage-ref" href="/task-monitor/tickets/{ref.displayId}"
                >{ref.displayId} — {ref.title}</a
              >
            {/each}
          </p>
        {/if}
        {#if lineage.splitInto.length > 0}
          <div class="lineage-group">
            <span class="lineage-label">Split into</span>
            <ul>
              {#each lineage.splitInto as ref (ref.ticketId)}
                <li>
                  <a class="lineage-ref" href="/task-monitor/tickets/{ref.displayId}"
                    >{ref.displayId} — {ref.title}</a
                  >
                  <span class="lineage-status">{STATUS_LABELS[ref.status] ?? ref.status}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </section>
    {/if}

    <TicketThread ticketId={ticket.id} onChanged={() => ticketId && load(ticketId)} />
  </article>
{/if}

<style lang="scss" src="./+page.scss"></style>
