<script lang="ts">
  import type { AgentProject, AgentTicket, EpicSummary, TicketAssignee } from '@dashboard/shared';
  import { TICKET_ASSIGNEES } from '@dashboard/shared';
  import { Pencil, Trash2, Layers } from 'lucide-svelte';
  import Button from '$lib/Button.svelte';
  import * as api from './api';
  import { projectIdColor } from './api';

  let {
    epic,
    project,
    summary,
    onEdit,
    onDelete,
    onUpdate,
  }: {
    epic: AgentTicket;
    project: AgentProject | undefined;
    summary: EpicSummary | undefined;
    onEdit: () => void;
    onDelete: () => void;
    onUpdate: () => void;
  } = $props();

  const done = $derived(summary?.done ?? 0);
  const total = $derived(summary?.total ?? 0);
  const pct = $derived(total > 0 ? Math.round((done / total) * 100) : 0);
  const detailHref = $derived(
    epic.displayId ? `/task-monitor/tickets/${epic.displayId}` : undefined,
  );

  function assigneeLabel(a: TicketAssignee | null): string {
    if (a === 'steve') return 'S';
    if (a === 'robot') return '🤖';
    return '—';
  }

  async function setAssignee(assignee: TicketAssignee | null) {
    if (epic.assignee === assignee) return;
    try {
      await api.updateTicket(epic.id, { assignee });
      onUpdate();
    } catch (e) {
      console.error('[EpicCard] setAssignee failed', e);
    }
  }
</script>

<article class="epic-card" data-id={epic.id}>
  <div class="epic-top">
    <span class="epic-badge" title="Epic"><Layers size={12} /></span>
    {#if epic.displayId}
      <a
        class="epic-id"
        style="--id-color: {projectIdColor(project)}"
        href={detailHref}
        title={project ? `${project.name} · open ${epic.displayId}` : `Open ${epic.displayId}`}
        >{epic.displayId}</a
      >
    {/if}
    <span class="epic-count" title="{done} of {total} members done">{done}/{total}</span>
  </div>

  <a class="epic-title" href={detailHref}>{epic.title}</a>

  <div class="epic-rollup" title="{pct}% complete">
    <div class="epic-rollup-fill" style="width: {pct}%"></div>
  </div>

  <div class="epic-actions">
    <select
      class="assignee-pill assignee-{epic.assignee ?? 'none'}"
      title="Epic signal — robot: whole epic is robot-doable · S: at least one member needs you"
      value={epic.assignee ?? ''}
      onchange={(e) => setAssignee((e.currentTarget.value || null) as TicketAssignee | null)}
    >
      <option value="">—</option>
      {#each TICKET_ASSIGNEES as a (a)}
        <option value={a}>{assigneeLabel(a)}</option>
      {/each}
    </select>
    <span class="spacer"></span>
    <Button variant="icon" title="Edit" aria-label="Edit" onclick={onEdit}><Pencil size={13} /></Button>
    <Button variant="icon" title="Archive" aria-label="Archive" onclick={onDelete}><Trash2 size={13} /></Button>
  </div>
</article>

<style lang="scss" src="./EpicCard.scss"></style>
