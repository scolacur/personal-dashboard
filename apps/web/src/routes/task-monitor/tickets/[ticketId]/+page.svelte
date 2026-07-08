<script lang="ts">
  import { page } from '$app/state';
  import type {
    AgentProject,
    AgentTicket,
    ResolvedRelation,
    TicketRelation,
    TicketStatus,
  } from '@dashboard/shared';
  import { PRIORITY_LABELS } from '@dashboard/shared';
  import * as api from '../../api';
  import { projectIdColor } from '../../api';
  import TicketThread from '$lib/TicketThread.svelte';
  import GlossaryModal from '$lib/GlossaryModal.svelte';
  import RelationPicker from '../../RelationPicker.svelte';
  import { RELATION_ACTIONS, relationLabel, type RelationAction } from '../../relation-logic';

  // The route param is the human-facing display id, e.g. 'PD-173'.
  const ticketId = $derived(page.params.ticketId);

  let ticket = $state<AgentTicket | null>(null);
  let project = $state<AgentProject | null>(null);
  let allTickets = $state<AgentTicket[]>([]);
  let relations = $state<ResolvedRelation[]>([]);
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
      allTickets = tickets;
      const found = tickets.find((t) => t.displayId === id) ?? null;
      if (!found) {
        notFound = true;
        return;
      }
      ticket = found;
      project =
        found.projectId !== null ? (projects.find((p) => p.id === found.projectId) ?? null) : null;
      relations = await api.fetchRelations(found.id);
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

  let glossaryOpen = $state(false);
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

  // ── Relations management (PD-322, D-051) ──────────────────────────────────
  // The relations picker + a per-row Remove make the detail page the authoritative place to
  // hand-manage every relation type; this supersedes PD-269's read-only split-only lineage view.
  let addMenuOpen = $state(false);
  let pickerOpen = $state(false);
  let pickerAction = $state<RelationAction | null>(null);

  // The picker excludes tickets already related of the chosen type; it reads raw rows, so map
  // this ticket's resolved relations back into (from,to) pairs for it.
  const relationRows = $derived<TicketRelation[]>(
    ticket
      ? relations.map((r) => ({
          id: r.id,
          fromTicketId: r.direction === 'from' ? ticket!.id : r.other.ticketId,
          toTicketId: r.direction === 'from' ? r.other.ticketId : ticket!.id,
          type: r.type,
          origin: r.origin,
          createdAt: r.createdAt,
        }))
      : [],
  );

  function chooseAdd(action: RelationAction) {
    addMenuOpen = false;
    pickerAction = action;
    pickerOpen = true;
  }

  async function removeRelation(rel: ResolvedRelation) {
    if (!ticket) return;
    const other = rel.other.displayId ?? `#${rel.other.ticketId}`;
    if (!confirm(`Remove "${relationLabel(rel)} ${other}"?`)) return;
    error = null;
    try {
      await api.deleteRelation(ticket.id, rel.id);
      if (ticketId) await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
    <div class="ticket-left">
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

      <section class="relations">
        <div class="relations-head">
          <h2>Relations</h2>
          <div class="add-rel-wrap">
            <button class="add-rel-btn" type="button" onclick={() => (addMenuOpen = !addMenuOpen)}
              >+ Add</button
            >
            {#if addMenuOpen}
              <button
                class="add-rel-scrim"
                type="button"
                aria-label="Close menu"
                onclick={() => (addMenuOpen = false)}
              ></button>
              <div class="add-rel-menu" role="menu">
                {#each RELATION_ACTIONS as action (action.key)}
                  <button
                    class="add-rel-item"
                    type="button"
                    role="menuitem"
                    onclick={() => chooseAdd(action)}>{action.label}</button
                  >
                {/each}
              </div>
            {/if}
          </div>
        </div>
        {#if relations.length === 0}
          <p class="muted">No relations.</p>
        {:else}
          <ul class="relation-list">
            {#each relations as rel (rel.id)}
              <li class="relation-row">
                <span class="relation-kind">{relationLabel(rel)}</span>
                <a class="relation-ref" href="/task-monitor/tickets/{rel.other.displayId}"
                  >{rel.other.displayId ?? `#${rel.other.ticketId}`} — {rel.other.title}</a
                >
                <span class="relation-status">{STATUS_LABELS[rel.other.status] ?? rel.other.status}</span>
                <button
                  class="relation-remove"
                  type="button"
                  title="Remove relation"
                  aria-label="Remove relation"
                  onclick={() => removeRelation(rel)}>×</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>

    <div class="ticket-right">
      {#if ticket.refined || ticket.refineState === null}
        <div class="refine-controls">
          {#if ticket.refined}
            <span class="refined-badge" title="This ticket has been refined">✓ Refined</span>
          {:else}
            <button class="start-refine" type="button" onclick={startRefine} disabled={starting}>
              {starting ? 'Starting…' : '✦ Start Refine'}
            </button>
          {/if}
        </div>
      {/if}

      <TicketThread ticketId={ticket.id} onChanged={() => ticketId && load(ticketId)} />

      <div class="refine-footer">
        <button
          class="info-btn"
          type="button"
          title="Refinement statuses"
          aria-label="Refinement statuses"
          onclick={() => (glossaryOpen = true)}>i</button
        >
        {#if !ticket.refined && ticket.refineState !== null}
          <button class="mark-refined" type="button" onclick={markRefined} disabled={markingRefined}>
            {markingRefined ? 'Marking…' : '✓ Mark refined'}
          </button>
        {/if}
      </div>
    </div>

    <GlossaryModal open={glossaryOpen} tab="refinement" onClose={() => (glossaryOpen = false)} />

    <RelationPicker
      open={pickerOpen}
      action={pickerAction}
      source={ticket}
      tickets={allTickets}
      relations={relationRows}
      onClose={() => (pickerOpen = false)}
      onCreated={() => ticketId && load(ticketId)}
    />
  </article>
{/if}

<style lang="scss" src="./+page.scss"></style>
