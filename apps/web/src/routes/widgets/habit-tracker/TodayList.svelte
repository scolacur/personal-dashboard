<script lang="ts">
  import type { HabitItemView } from '@dashboard/shared';

  /**
   * The Today checklist (PD-721). A flat list of active habits in manual order; tap a row to tick,
   * tap again to untick, no confirmation. Shared by the card (`compact`) and the page's Today tab.
   * Read-only — no editing of items here (that is the Habits tab).
   */
  let {
    items,
    completed,
    onToggle,
    loaded = true,
    compact = false,
  }: {
    items: HabitItemView[];
    completed: Set<number>;
    onToggle: (item: HabitItemView) => void;
    loaded?: boolean;
    compact?: boolean;
  } = $props();
</script>

<ul class="today-list" class:compact aria-label="Today's habits">
  {#each items as item (item.id)}
    {@const done = completed.has(item.id)}
    <li>
      <button
        type="button"
        class="today-row"
        class:done
        aria-pressed={done}
        onclick={() => onToggle(item)}
      >
        <span class="check" aria-hidden="true">{done ? '✓' : ''}</span>
        <span class="name">{item.name}</span>
      </button>
    </li>
  {/each}

  {#if items.length === 0 && loaded}
    <li class="empty">
      {compact ? 'No habits yet.' : 'No habits yet — add one on the Habits tab.'}
    </li>
  {/if}
</ul>

<style lang="scss" src="./TodayList.scss"></style>
