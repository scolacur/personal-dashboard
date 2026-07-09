<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import { ticketMatchesQuery } from './filter-logic';

  let {
    open,
    source,
    tickets,
    onClose,
    onPicked,
  }: {
    open: boolean;
    source: AgentTicket | null;
    tickets: AgentTicket[];
    onClose: () => void;
    onPicked: (epicId: number) => void;
  } = $props();

  let query = $state('');
  $effect(() => {
    if (open) query = '';
  });

  // Epics in the source's project, excluding the source itself and the Epic it's already in.
  const epics = $derived(
    source
      ? tickets
          .filter(
            (t) =>
              t.isEpic &&
              t.projectId === source.projectId &&
              t.id !== source.id &&
              t.id !== source.epicId &&
              ticketMatchesQuery(t, query),
          )
          .slice(0, 50)
      : [],
  );

  function pick(epicId: number) {
    onPicked(epicId);
    onClose();
  }
</script>

<Modal {open} title="Add to Epic" {onClose}>
  {#if source}
    <p class="picker-source">
      <span class="picker-source-label">For</span>
      <strong>{source.displayId ?? `#${source.id}`}</strong> — {source.title}
    </p>
  {/if}
  <!-- svelte-ignore a11y_autofocus -->
  <input class="picker-search" type="search" placeholder="Filter epics…" bind:value={query} autofocus />
  <ul class="picker-list">
    {#each epics as e (e.id)}
      <li>
        <button type="button" class="picker-row" onclick={() => pick(e.id)}>
          <span class="picker-row-id">{e.displayId ?? `#${e.id}`}</span>
          <span class="picker-row-title">{e.title}</span>
        </button>
      </li>
    {:else}
      <li class="picker-empty">No epics in this project.</li>
    {/each}
  </ul>
</Modal>

<style lang="scss" src="./EpicPicker.scss"></style>
