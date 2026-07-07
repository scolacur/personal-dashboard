<script lang="ts">
  import type { AgentProject, AgentState, AgentTicket, RefineState, TicketAssignee, TicketPriority } from '@dashboard/shared';
  import { TICKET_ASSIGNEES, ASSIGNEE_LABELS, TICKET_PRIORITIES, AGENT_STATE_LABELS } from '@dashboard/shared';
  import GithubMark from '$lib/icons/GithubMark.svelte';
  import { Pencil, Copy, Trash2, ClipboardCopy, Sparkles } from 'lucide-svelte';
  import Button from '$lib/Button.svelte';
  import * as api from './api';
  import { projectIdColor } from './api';

  let {
    ticket,
    project,
    condensed,
    dragging,
    dropBefore,
    isLocked,
    onDragStart,
    onDragEnd,
    onEdit,
    onDuplicate,
    onCopy,
    onDelete,
    onRefine,
    onOpenStatusLegend,
    onUpdate,
  }: {
    ticket: AgentTicket;
    project: AgentProject | undefined;
    condensed: boolean;
    dragging: boolean;
    dropBefore: boolean;
    isLocked: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onEdit: () => void;
    onDuplicate: () => void;
    onCopy: () => void;
    onDelete: () => void;
    onRefine: () => void;
    onOpenStatusLegend: (state: AgentState) => void;
    onUpdate: () => void;
  } = $props();

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
    grilling: 'Grilling…',
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
      {#if ticket.refined}
        <span class="refined-mark" title="Refined">✓ Refined</span>
      {:else if ticket.refineState}
        <a
          class="refine-pill refine-{ticket.refineState}"
          href={ticket.displayId ? `/task-monitor/tickets/${ticket.displayId}` : undefined}
          draggable="false"
          title="Refine session — {REFINE_STATE_LABELS[ticket.refineState]}"
        >{REFINE_STATE_LABELS[ticket.refineState]}</a>
      {/if}
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
  {#if ticket.body && !condensed}
    <p class="card-body">{ticket.body}</p>
  {/if}
  {#if ticket.agentState}
    <div class="card-status-row">
      <button
        class="agent-state-badge {agentStateClass(ticket.agentState)}"
        type="button"
        aria-label="Agent state: {AGENT_STATE_LABELS[ticket.agentState]}. Click to view Sortie status guide."
        onclick={() => onOpenStatusLegend(ticket.agentState!)}
      >{AGENT_STATE_LABELS[ticket.agentState]}</button>
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
    {#if (ticket.status === 'prioritized' || ticket.status === 'backlog') && ticket.refineState === null && !ticket.refined}
      <Button
        variant="icon"
        accent={true}
        title="Refine — start a grounded triage session"
        aria-label="Refine"
        onclick={onRefine}
      ><Sparkles size={13} /></Button>
    {/if}
    <Button variant="icon" title="Edit" aria-label="Edit" onclick={onEdit}><Pencil size={13} /></Button>
    <Button variant="icon" title="Duplicate" aria-label="Duplicate" onclick={onDuplicate}><Copy size={13} /></Button>
    <Button variant="icon" title="Copy issue text" aria-label="Copy issue text" onclick={onCopy}><ClipboardCopy size={13} /></Button>
    <Button variant="icon" title="Delete" aria-label="Delete" onclick={onDelete}><Trash2 size={13} /></Button>
  </div>
</article>

<style lang="scss" src="./TicketCard.scss"></style>
