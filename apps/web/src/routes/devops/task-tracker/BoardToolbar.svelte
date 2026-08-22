<script lang="ts">
  import type { AgentProject, TicketPriority, TicketStatus } from '@dashboard/shared';
  import { TICKET_PRIORITIES, PRIORITY_LABELS } from '@dashboard/shared';
  import type { SvelteSet } from 'svelte/reactivity';
  import Button from '$lib/Button.svelte';
  import type { AssigneeFilter, RefineFilter } from '../filter-logic';

  /**
   * The board's two toolbar rows: title + search + actions on row 1, every filter on row 2.
   *
   * The lane menu and the ⌘K search shortcut are owned here rather than by the page — they are
   * this toolbar's own affordances, and nothing outside it reads their state.
   */
  let {
    search = $bindable(),
    filterType = $bindable(),
    filterPriority = $bindable(),
    filterRefine = $bindable(),
    filterProjectId,
    filterAssignee,
    projects,
    columns,
    hiddenLanes,
    addDisabled = false,
    shortcutsEnabled = true,
    onProjectFilter,
    onAssigneeFilter,
    onToggleLane,
    onOpenGlossary,
    onAdd,
  }: {
    search: string;
    filterType: 'all' | 'epics' | 'tickets' | 'epics-lone';
    filterPriority: 'all' | 'none' | TicketPriority;
    filterRefine: RefineFilter;
    filterProjectId: number | null;
    filterAssignee: AssigneeFilter;
    projects: AgentProject[];
    columns: { status: TicketStatus; label: string }[];
    hiddenLanes: SvelteSet<TicketStatus>;
    addDisabled?: boolean;
    /** False while a modal owns the keyboard, so ⌘K doesn't steal focus out of it. */
    shortcutsEnabled?: boolean;
    onProjectFilter: (projectId: number | null) => void;
    onAssigneeFilter: (value: AssigneeFilter) => void;
    onToggleLane: (status: TicketStatus) => void;
    onOpenGlossary: () => void;
    onAdd: () => void;
  } = $props();

  let laneMenuOpen = $state(false);
  let laneMenuRef = $state<HTMLElement | null>(null);
  let searchInputRef = $state<HTMLInputElement | null>(null);

  function onWindowClick(e: MouseEvent) {
    if (laneMenuOpen && laneMenuRef && !laneMenuRef.contains(e.target as Node)) {
      laneMenuOpen = false;
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.metaKey && e.key === 'k' && shortcutsEnabled) {
      e.preventDefault();
      if (document.activeElement === searchInputRef) {
        searchInputRef?.blur();
      } else {
        searchInputRef?.focus();
        searchInputRef?.select();
      }
    }
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="section-head">
  <h2 class="section-title">Tickets</h2>
  <label class="ticket-search" class:has-text={search !== ''}>
    <span class="sr-label">Search tickets</span>
    <input type="search" bind:value={search} bind:this={searchInputRef} placeholder="Search tickets…" />
    {#if search}
      <button
        type="button"
        class="search-clear"
        aria-label="Clear search"
        onclick={() => { search = ''; searchInputRef?.focus(); }}
      >×</button>
    {/if}
    <span class="search-hint" aria-hidden="true"><kbd>⌘K</kbd></span>
  </label>
  <div class="head-actions">
    <Button variant="ghost" title="Glossary" onclick={onOpenGlossary}>Glossary</Button>
    <div class="lanes-menu-wrap" bind:this={laneMenuRef}>
      <Button
        variant="ghost"
        title="Show/hide lanes"
        aria-label="Show/hide lanes"
        aria-expanded={laneMenuOpen}
        onclick={() => (laneMenuOpen = !laneMenuOpen)}
      >Lanes</Button>
      {#if laneMenuOpen}
        <div class="lanes-menu">
          {#each columns as col (col.status)}
            <label class="lanes-menu-item">
              <input
                type="checkbox"
                checked={!hiddenLanes.has(col.status)}
                onchange={() => onToggleLane(col.status)}
              />
              <span>{col.label}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <div class="add-ticket-wrap">
      <Button variant="primary" onclick={onAdd} disabled={addDisabled}>+ Add Ticket</Button>
    </div>
  </div>
</div>

<!-- Second toolbar row: all filters (D-054 adds Ticket Type). Search + buttons stay on row 1. -->
<div class="filters-row">
  <label class="type-filter">
    <span class="sr-label">Type</span>
    <select bind:value={filterType}>
      <option value="all">Epics &amp; Tickets</option>
      <option value="epics-lone">Epics &amp; Lone Tickets</option>
      <option value="epics">Epics only</option>
      <option value="tickets">Tickets only</option>
    </select>
  </label>
  <label class="project-filter">
    <span class="sr-label">Project</span>
    <select
      value={filterProjectId === null ? 'all' : String(filterProjectId)}
      onchange={(e) => {
        const v = e.currentTarget.value;
        onProjectFilter(v === 'all' ? null : Number(v));
      }}
    >
      <option value="all">All projects</option>
      {#each projects as p (p.id)}
        <option value={String(p.id)}>{p.name}</option>
      {/each}
    </select>
  </label>
  <label class="priority-filter">
    <span class="sr-label">Priority</span>
    <select bind:value={filterPriority}>
      <option value="all">All priorities</option>
      {#each TICKET_PRIORITIES as p (p)}
        <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
      {/each}
      <option value="none">— None</option>
    </select>
  </label>
  <label class="assignee-filter">
    <span class="sr-label">Assignee</span>
    <select
      value={filterAssignee}
      onchange={(e) => onAssigneeFilter(e.currentTarget.value as AssigneeFilter)}
    >
      <option value="all">All assignees</option>
      <option value="robot">🤖 Robot</option>
      <option value="steve">S Steve</option>
      <option value="none">— Unassigned</option>
    </select>
  </label>
  <label class="refinement-filter">
    <span class="sr-label">Refinement</span>
    <select bind:value={filterRefine}>
      <option value="all">All refinement statuses</option>
      <option value="refined">Refined</option>
      <option value="refining">Refining</option>
      <option value="awaiting-human">Needs you</option>
      <option value="unrefined">Unrefined</option>
    </select>
  </label>
</div>

<style lang="scss" src="./BoardToolbar.scss"></style>
