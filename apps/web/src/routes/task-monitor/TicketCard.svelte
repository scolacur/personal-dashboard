<script lang="ts">
  import type { AgentProject, AgentState, AgentTicket, RefineState, TicketAssignee, TicketPriority } from '@dashboard/shared';
  import { TICKET_ASSIGNEES, ASSIGNEE_LABELS, TICKET_PRIORITIES, AGENT_STATE_LABELS } from '@dashboard/shared';
  import GithubMark from '$lib/icons/GithubMark.svelte';
  import { Pencil, Copy, Trash2, ClipboardCopy, MoreVertical } from 'lucide-svelte';
  import Button from '$lib/Button.svelte';
  import * as api from './api';
  import { projectIdColor } from './api';
  import { RELATION_ACTIONS, type RelationAction, type RelationBadges } from './relation-logic';

  let {
    ticket,
    project,
    dragging,
    dropBefore,
    isLocked,
    badges,
    onDragStart,
    onDragEnd,
    onEdit,
    onDuplicate,
    onCopy,
    onDelete,
    onRefine,
    onRelationAction,
    onAddToEpic,
    onRemoveFromEpic,
    onOpenStatusLegend,
    onUpdate,
  }: {
    ticket: AgentTicket;
    project: AgentProject | undefined;
    dragging: boolean;
    dropBefore: boolean;
    isLocked: boolean;
    badges: RelationBadges;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onEdit: () => void;
    onDuplicate: () => void;
    onCopy: () => void;
    onDelete: () => void;
    onRefine: () => void;
    onRelationAction: (action: RelationAction) => void;
    onAddToEpic: () => void;
    onRemoveFromEpic: () => void;
    onOpenStatusLegend: (state: AgentState) => void;
    onUpdate: () => void;
  } = $props();

  // ⋮ "Mark as →" relation menu (D-051, PD-322).
  let menuOpen = $state(false);
  const detailHref = $derived(ticket.displayId ? `/task-monitor/tickets/${ticket.displayId}` : undefined);

  function chooseRelation(action: RelationAction) {
    menuOpen = false;
    onRelationAction(action);
  }

  function chooseEpicAction(fn: () => void) {
    menuOpen = false;
    fn();
  }

  function bandKey(p: TicketPriority | null): string {
    return p ?? 'none';
  }

  function agentStateClass(s: AgentState): string {
    return `agent-state-${s}`;
  }

  function assigneeLabel(assignee: TicketAssignee | null): string {
    if (assignee === 'steve') return 'S';
    if (assignee === 'robot') return '🤖';
    return '—';
  }

  const REFINE_STATE_LABELS: Record<RefineState, string> = {
    refining: 'Refining…',
    'awaiting-human': 'Needs you',
  };

  async function setPriority(priority: TicketPriority | null) {
    if (ticket.priority === priority) return;
    try {
      await api.updateTicket(ticket.id, { priority });
      onUpdate();
    } catch (e) {
      console.error('[TicketCard] setPriority failed', e);
    }
  }

  async function setAssignee(assignee: TicketAssignee | null) {
    if (ticket.assignee === assignee) return;
    try {
      await api.updateTicket(ticket.id, { assignee });
      onUpdate();
    } catch (e) {
      console.error('[TicketCard] setAssignee failed', e);
    }
  }
</script>

<article
  class="card"
  class:done={ticket.status === 'completed'}
  class:dragging={dragging}
  class:drop-before={dropBefore}
  class:locked={isLocked}
  class:shimmer={ticket.agentState === 'working'}
  data-id={ticket.id}
  data-priority={bandKey(ticket.priority)}
  draggable={true}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
>
  <div class="card-top">
    <div class="card-top-left">
      {#if ticket.displayId}
        <a
          class="ticket-id"
          style="--id-color: {projectIdColor(project)}"
          href="/task-monitor/tickets/{ticket.displayId}"
          title={project ? `${project.name} · open ${ticket.displayId}` : `Open ${ticket.displayId}`}
          draggable="false">{ticket.displayId}</a
        >
      {/if}
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
      <select
        class="priority priority-{bandKey(ticket.priority)}"
        title="Set priority"
        value={ticket.priority ?? ''}
        onchange={(e) => setPriority((e.currentTarget.value || null) as TicketPriority | null)}
      >
        <option value="">—</option>
        {#each TICKET_PRIORITIES as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </span>
  </div>
  <p class="card-title">{ticket.title}</p>
  {#if badges.blockedBy > 0 || badges.blocking > 0 || badges.split}
    <div class="card-relations">
      {#if badges.blockedBy > 0}
        <a class="rel-badge rel-blocked" href={detailHref} draggable="false" title="Blocked by {badges.blockedBy} unresolved ticket(s)">⛔ blocked by {badges.blockedBy}</a>
      {/if}
      {#if badges.blocking > 0}
        <a class="rel-badge rel-blocking" href={detailHref} draggable="false" title="Blocking {badges.blocking} unresolved ticket(s)">🚧 blocking {badges.blocking}</a>
      {/if}
      {#if badges.split}
        <a class="rel-badge rel-split" href={detailHref} draggable="false" title="Part of a split lineage">{badges.splitOrigin === 'agent' ? 'auto-split 🤖' : 'split'}</a>
      {/if}
    </div>
  {/if}
  {#if ticket.refined || ticket.refineState || ticket.agentState || (ticket.status !== 'completed' && ticket.status !== 'closed')}
    <div class="card-status-row">
      <!-- Left: Refine-agent state (outlined pill). Always occupies the left slot so the
           Robot badge stays right-aligned even when there's no refine state. -->
      <span class="status-left">
        {#if ticket.refined}
          <span class="refined-mark" title="Refined">✓ Refined</span>
        {:else if ticket.refineState}
          <a
            class="refine-pill refine-{ticket.refineState}"
            href={ticket.displayId ? `/task-monitor/tickets/${ticket.displayId}` : undefined}
            draggable="false"
            title="Refine session — {REFINE_STATE_LABELS[ticket.refineState]}"
          >{REFINE_STATE_LABELS[ticket.refineState]}</a>
        {:else if ticket.status !== 'completed' && ticket.status !== 'closed'}
          <button
            class="refine-pill refine-start"
            type="button"
            title="Refine — start a grounded triage session"
            onclick={onRefine}
          >Not refined</button>
        {/if}
      </span>
      <!-- Right: Robot agent state (filled pill). -->
      {#if ticket.agentState}
        <button
          class="agent-state-badge {agentStateClass(ticket.agentState)}"
          type="button"
          aria-label="Agent state: {AGENT_STATE_LABELS[ticket.agentState]}. Click to view Robot status guide."
          onclick={() => onOpenStatusLegend(ticket.agentState!)}
        >{AGENT_STATE_LABELS[ticket.agentState]}</button>
      {/if}
    </div>
  {/if}
  <div class="card-actions">
    <select
      class="assignee-pill assignee-{ticket.assignee ?? 'none'}"
      title={isLocked
        ? 'Agent-controlled — cannot reassign'
        : `Assignee: ${ticket.assignee ? ASSIGNEE_LABELS[ticket.assignee] : 'None'}`}
      value={ticket.assignee ?? ''}
      disabled={isLocked}
      onchange={(e) => setAssignee((e.currentTarget.value || null) as TicketAssignee | null)}
    >
      <option value="">—</option>
      {#each TICKET_ASSIGNEES as a (a)}
        <option value={a}>{assigneeLabel(a)}</option>
      {/each}
    </select>
    <span class="spacer"></span>
    <Button variant="icon" title="Edit" aria-label="Edit" onclick={onEdit}><Pencil size={13} /></Button>
    <Button variant="icon" title="Duplicate" aria-label="Duplicate" onclick={onDuplicate}><Copy size={13} /></Button>
    <Button variant="icon" title="Copy issue text" aria-label="Copy issue text" onclick={onCopy}><ClipboardCopy size={13} /></Button>
    <Button variant="icon" title="Delete" aria-label="Delete" onclick={onDelete}><Trash2 size={13} /></Button>
    <div class="kebab-wrap">
      <Button variant="icon" title="Mark as…" aria-label="Relation actions" onclick={() => (menuOpen = !menuOpen)}><MoreVertical size={13} /></Button>
      {#if menuOpen}
        <button class="kebab-scrim" type="button" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
        <div class="kebab-menu" role="menu">
          <p class="kebab-heading">Mark as…</p>
          {#each RELATION_ACTIONS as action (action.key)}
            <button class="kebab-item" type="button" role="menuitem" onclick={() => chooseRelation(action)}>{action.label}</button>
          {/each}
          {#if !ticket.isEpic}
            <div class="kebab-divider"></div>
            <button class="kebab-item" type="button" role="menuitem" onclick={() => chooseEpicAction(onAddToEpic)}>{ticket.epicId ? 'Move to Epic…' : 'Add to Epic…'}</button>
            {#if ticket.epicId}
              <button class="kebab-item" type="button" role="menuitem" onclick={() => chooseEpicAction(onRemoveFromEpic)}>Remove from Epic</button>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
</article>

<style lang="scss" src="./TicketCard.scss"></style>
