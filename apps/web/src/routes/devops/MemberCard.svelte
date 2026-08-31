<script lang="ts">
  import type { AgentTicket, TicketAssignee } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import {
    MEMBER_ASSIGNEES,
    assigneeGlyph,
    canEditMember,
    memberAssigneeHint,
    refinementBadge,
  } from './epic-members';

  /**
   * An Epic member as a board card (PD-554).
   *
   * Deliberately not `TicketCard`. That card requires eleven callbacks — edit, duplicate, copy,
   * refine, relations, spin-off, the status legend — and on an Epic page most of them are
   * meaningless; passing no-ops would render menu items that silently do nothing, which is worse
   * than not offering them. The ticket asks for exactly this: drop the controls that make no sense
   * epic-scoped.
   *
   * **The `.card` class and the two data attributes are a contract with `TicketBoard`**, whose
   * drag measures `.card[data-id][data-priority]` to find the insertion point. A card without them
   * is invisible to the drop logic and lands at the end of its lane every time.
   */
  let {
    ticket,
    dragging,
    dropBefore,
    onDragStart,
    onDragEnd,
    onAssignee,
  }: {
    ticket: AgentTicket;
    dragging: boolean;
    dropBefore: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onAssignee: (assignee: TicketAssignee | null) => void;
  } = $props();

  const editable = $derived(canEditMember(ticket));
</script>

{#if dropBefore}<div class="drop-line"></div>{/if}
<article
  class="card member-card"
  class:dragging
  class:frozen={!editable}
  data-id={ticket.id}
  data-priority={ticket.priority ?? 'none'}
  draggable={editable}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
  role="listitem"
>
  <div class="member-card-head">
    <a class="member-card-id" href="/devops/tickets/{ticket.displayId}">{ticket.displayId}</a>
    <!-- Priority is the Epic's and cascades (D-080), so it is a read-out, never a control. -->
    <span class="member-card-prio">{ticket.priority ?? '—'}</span>
  </div>
  <p class="member-card-title">{ticket.title}</p>
  <div class="member-card-foot">
    <select
      class="assignee-pill assignee-{ticket.assignee ?? 'none'}"
      aria-label="Assignee for {ticket.displayId}"
      title={memberAssigneeHint(ticket)}
      disabled={!editable}
      value={ticket.assignee ?? ''}
      onchange={(e) => onAssignee((e.currentTarget.value || null) as TicketAssignee | null)}
    >
      {#each MEMBER_ASSIGNEES as a (a ?? 'none')}
        <option value={a ?? ''}>{assigneeGlyph(a)}</option>
      {/each}
    </select>
    {#if refinementBadge(ticket)}
      {@const badge = refinementBadge(ticket)!}
      <span class={badge.cls} title={badge.title}>{badge.text}</span>
    {/if}
    {#if ticket.agentState}
      <span class="member-card-state">{AGENT_STATE_LABELS[ticket.agentState] ?? ticket.agentState}</span>
    {/if}
  </div>
</article>

<style lang="scss" src="./MemberCard.scss"></style>
