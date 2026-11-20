<script lang="ts">
  import { STREAK_BADGE_MIN } from '@dashboard/shared';
  import { topLevelSets, type HabitTreeNode } from './tree';

  /**
   * The Today checklist (PD-721; schedules PD-722; sets PD-723). A tree of due habits and sets in
   * manual order; tap a leaf to tick/untick, tap a set's checkbox to tick/untick all its due
   * children. Shared by the card (`compact`) and the page's Today tab. Read-only editing of items
   * (that is the Habits tab).
   *
   * Only **due** nodes render. Sets are expanded by default; a done set collapses itself to one line
   * ("✓ Vitamins 4/4 🔥12") and tapping it re-expands. Collapse state is per-device (localStorage).
   * Filter chips are **All** plus one per top-level set, each showing that set's progress; a set chip
   * narrows the list to that set's subtree.
   */
  let {
    tree,
    onToggleLeaf,
    onToggleSet,
    onOpenItem,
    loaded = true,
    compact = false,
  }: {
    tree: HabitTreeNode[];
    onToggleLeaf: (item: HabitTreeNode['item']) => void;
    onToggleSet: (node: HabitTreeNode) => void;
    /** Open Log › By Habit for the item (PD-726). Omitted on the card, where there is no Log tab. */
    onOpenItem?: (id: number) => void;
    loaded?: boolean;
    compact?: boolean;
  } = $props();

  const COLLAPSE_KEY = 'habit-tracker:set-collapse';

  // Per-device collapse overrides: id → 'open' | 'closed'. Absent means "default" (open unless done).
  let overrides = $state<Record<number, 'open' | 'closed'>>(loadOverrides());

  function loadOverrides(): Record<number, 'open' | 'closed'> {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return raw ? (JSON.parse(raw) as Record<number, 'open' | 'closed'>) : {};
    } catch {
      return {};
    }
  }

  function persistOverrides() {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(overrides));
    } catch {
      // A private-mode / quota failure just means collapse state is not remembered — not fatal.
    }
  }

  // A set is open by default, unless it is done (a done set collapses itself). An explicit override wins.
  function isOpen(node: HabitTreeNode): boolean {
    const o = overrides[node.item.id];
    return o ? o === 'open' : !node.done;
  }

  function toggleCollapse(node: HabitTreeNode) {
    overrides = { ...overrides, [node.item.id]: isOpen(node) ? 'closed' : 'open' };
    persistOverrides();
  }

  const sets = $derived(topLevelSets(tree));

  // Filter chips: 'all' or a top-level set id.
  let chip = $state<'all' | number>('all');
  // If the selected set disappears (archived/moved), fall back to All.
  $effect(() => {
    if (chip !== 'all' && !sets.some((s) => s.item.id === chip)) chip = 'all';
  });

  const roots = $derived(
    chip === 'all' ? tree.filter((n) => n.due) : tree.filter((n) => n.item.id === chip && n.due),
  );

  function setCheckState(node: HabitTreeNode): 'done' | 'partial' | 'empty' {
    if (node.done) return 'done';
    return (node.progress?.done ?? 0) > 0 ? 'partial' : 'empty';
  }
</script>

{#if sets.length > 0}
  <div class="chips" role="group" aria-label="Filter by set">
    <button type="button" class="chip" class:selected={chip === 'all'} onclick={() => (chip = 'all')}>
      All
    </button>
    {#each sets as s (s.item.id)}
      <button
        type="button"
        class="chip"
        class:selected={chip === s.item.id}
        class:done={s.done}
        onclick={() => (chip = s.item.id)}
      >
        {s.item.name}
        {#if s.progress}<span class="chip-progress">{s.progress.done}/{s.progress.total}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

{#snippet renderNode(node: HabitTreeNode)}
  {#if node.isSet}
    {@const open = isOpen(node)}
    {@const state = setCheckState(node)}
    <li class="set">
      <div class="set-row" class:done={node.done}>
        <button
          type="button"
          class="check set-check"
          class:done={state === 'done'}
          class:partial={state === 'partial'}
          aria-pressed={node.done}
          aria-label={node.done ? `Untick ${node.item.name}` : `Complete ${node.item.name}`}
          onclick={() => onToggleSet(node)}
        >
          <span aria-hidden="true">{state === 'done' ? '✓' : state === 'partial' ? '–' : ''}</span>
        </button>
        <button
          type="button"
          class="set-name"
          aria-expanded={open}
          onclick={() => toggleCollapse(node)}
        >
          <span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span class="name">{node.done ? '✓ ' : ''}{node.item.name}</span>
          {#if node.progress}
            <span class="set-progress">{node.progress.done}/{node.progress.total}</span>
          {/if}
          {#if node.streak.current >= STREAK_BADGE_MIN}
            <span class="streak" title={`${node.streak.current}-period streak`}>🔥{node.streak.current}</span>
          {/if}
        </button>
        {#if onOpenItem}
          <button
            type="button"
            class="open-cal"
            title="Open calendar"
            aria-label={`Open ${node.item.name} calendar`}
            onclick={() => onOpenItem?.(node.item.id)}
          >
            📅
          </button>
        {/if}
      </div>
      {#if open}
        <ul class="children">
          {#each node.children.filter((c) => c.due) as child (child.item.id)}
            {@render renderNode(child)}
          {/each}
        </ul>
      {/if}
    </li>
  {:else}
    {@const weekDone = node.row.perWeek?.met ?? false}
    <li class="leaf">
      <button
        type="button"
        class="today-row"
        class:done={node.done || weekDone}
        aria-pressed={node.done}
        onclick={() => onToggleLeaf(node.item)}
      >
        <span class="check" aria-hidden="true">{node.done || weekDone ? '✓' : ''}</span>
        <span class="name">{node.item.name}</span>
        {#if node.row.perWeek}
          <span class="week-progress" class:met={weekDone}>
            {weekDone ? '✓ ' : ''}{node.row.perWeek.count}/{node.row.perWeek.target} this week
          </span>
        {/if}
        {#if node.streak.current >= STREAK_BADGE_MIN}
          <span class="streak" title={`${node.streak.current}-period streak`}>🔥{node.streak.current}</span>
        {/if}
      </button>
      {#if onOpenItem}
        <button
          type="button"
          class="open-cal"
          title="Open calendar"
          aria-label={`Open ${node.item.name} calendar`}
          onclick={() => onOpenItem?.(node.item.id)}
        >
          📅
        </button>
      {/if}
    </li>
  {/if}
{/snippet}

<ul class="today-list" class:compact aria-label="Today's habits">
  {#each roots as node (node.item.id)}
    {@render renderNode(node)}
  {/each}

  {#if roots.length === 0 && loaded}
    <li class="empty">
      {compact ? 'Nothing due today.' : 'Nothing due today — add or schedule a habit on the Habits tab.'}
    </li>
  {/if}
</ul>

<style lang="scss" src="./TodayList.scss"></style>
