<script lang="ts">
  import type { AgentTicket, TicketRelation } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import * as api from './api';
  import { ticketMatchesQuery } from './filter-logic';
  import type { RelationAction } from './relation-logic';

  let {
    open,
    action,
    source,
    tickets,
    relations,
    onClose,
    onCreated,
  }: {
    open: boolean;
    action: RelationAction | null;
    source: AgentTicket | null;
    tickets: AgentTicket[];
    relations: TicketRelation[];
    onClose: () => void;
    onCreated: (message: string) => void;
  } = $props();

  let query = $state('');
  let submitting = $state(false);
  let errorMsg = $state<string | null>(null);

  // Reset the field whenever the picker (re)opens for a new action.
  $effect(() => {
    if (open) {
      query = '';
      errorMsg = null;
    }
  });

  // Tickets already related to the source of this action's type (either direction) — excluded so
  // the same link can't be drawn twice.
  const excludedIds = $derived.by(() => {
    const ids: number[] = [];
    if (source) ids.push(source.id);
    if (action && source) {
      for (const r of relations) {
        if (r.type !== action.type) continue;
        if (r.fromTicketId === source.id) ids.push(r.toTicketId);
        else if (r.toTicketId === source.id) ids.push(r.fromTicketId);
      }
    }
    return new Set(ids);
  });

  const matches = $derived(
    tickets
      .filter((t) => !excludedIds.has(t.id) && ticketMatchesQuery(t, query))
      .slice(0, 50),
  );

  async function pick(target: AgentTicket) {
    if (!action || !source || submitting) return;
    const { fromId, toId } = action.build(source.id, target.id);
    // D-051: blocking a ticket that's already queued leaves blocked work sitting in the queue —
    // allowed, but confirm it's intentional (no auto-eviction).
    if (action.type === 'blocks') {
      const blocked = toId === source.id ? source : target;
      if (blocked.status === 'robot_queue') {
        const ok = confirm(
          `${blocked.displayId ?? 'This ticket'} is already in Robot's Queue. Adding this blocker leaves blocked work queued — it won't be evicted. Add anyway?`,
        );
        if (!ok) return;
      }
    }
    submitting = true;
    errorMsg = null;
    try {
      await api.createRelation(source.id, fromId, toId, action.type);
      onCreated(`${action.label.replace('…', '')} ${target.displayId ?? `#${target.id}`}.`);
      onClose();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {open} title={action?.pickerTitle ?? 'Add relation'} {onClose}>
  {#if source}
    <p class="picker-source">
      <span class="picker-source-label">For</span>
      <strong>{source.displayId ?? `#${source.id}`}</strong>
      — {source.title}
    </p>
  {/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input
    class="picker-search"
    type="search"
    placeholder="Filter tickets…"
    bind:value={query}
    autofocus
    disabled={submitting}
  />
  {#if errorMsg}
    <p class="picker-error" role="alert">{errorMsg}</p>
  {/if}
  <ul class="picker-list">
    {#each matches as t (t.id)}
      <li>
        <button type="button" class="picker-row" onclick={() => pick(t)} disabled={submitting}>
          <span class="picker-row-id">{t.displayId ?? `#${t.id}`}</span>
          <span class="picker-row-title">{t.title}</span>
          <span class="picker-row-status">{t.status.replace(/_/g, ' ')}</span>
        </button>
      </li>
    {:else}
      <li class="picker-empty">No matching tickets.</li>
    {/each}
  </ul>
</Modal>

<style lang="scss" src="./RelationPicker.scss"></style>
