<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { STREAK_BADGE_MIN, type HabitMetricTodayRow } from '@dashboard/shared';
  import { flattenTree, subtreeItemIds, topLevelSets, type HabitTreeNode } from './tree';
  import { isStreakMilestone } from './completion-feedback';
  import MetricInput from './MetricInput.svelte';

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
    metrics = [],
    onToggleLeaf,
    onToggleSet,
    onMetric,
    loaded = true,
    compact = false,
    isToday = true,
    chip = $bindable('all'),
  }: {
    tree: HabitTreeNode[];
    metrics?: HabitMetricTodayRow[];
    onToggleLeaf: (item: HabitTreeNode['item']) => void;
    onToggleSet: (node: HabitTreeNode) => void;
    onMetric?: (itemId: number, value: string | null) => void;
    loaded?: boolean;
    compact?: boolean;
    /** False when the Today surface is showing a past habit day (PD-779 ([Habit Tracker] date header + day arrows on Today)). */
    isToday?: boolean;
    /**
     * The selected filter chip: 'all' or a top-level set id. Bindable so the selection survives a day
     * change, which re-creates this list for the slide (PD-779 ([Habit Tracker] date header + day
     * arrows on Today)).
     */
    chip?: 'all' | number;
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

  // If the selected set disappears (archived/moved), fall back to All.
  $effect(() => {
    if (chip !== 'all' && !sets.some((s) => s.item.id === chip)) chip = 'all';
  });

  const roots = $derived(
    chip === 'all' ? tree.filter((n) => n.due) : tree.filter((n) => n.item.id === chip && n.due),
  );

  // Metrics (PD-724) sit in their own section below the habits. Under a set chip they are filtered to
  // that set — a metric belongs when its parent is anywhere in the set's subtree.
  const selectedMetrics = $derived.by(() => {
    if (chip === 'all') return metrics;
    const node = sets.find((s) => s.item.id === chip);
    if (!node) return [];
    const ids = subtreeItemIds(node);
    return metrics.filter((m) => m.item.parentId !== null && ids.has(m.item.parentId));
  });

  function setCheckState(node: HabitTreeNode): 'done' | 'partial' | 'empty' {
    if (node.done) return 'done';
    return (node.progress?.done ?? 0) > 0 ? 'partial' : 'empty';
  }

  /**
   * Completion-feedback layers (T889, spec §3): a spring-fill on a leaf's checkbox when it is ticked,
   * a pulse on a set's row and chip when the set completes, and a flourish on the streak badge when it
   * reaches a milestone (7/30/100/365). All are CSS transitions with no new dependency.
   *
   * We only animate real *transitions* — detected by diffing the current tree against the previous
   * render — so nothing fires on initial load or on a re-pull that doesn't change a node's state.
   * Under `prefers-reduced-motion` we skip the whole effect, leaving the instant `.done` state change.
   */
  const reducedMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Previous-render state for transition detection — plain objects (not reactive, not read in markup).
  const prevDone: Record<number, boolean> = {};
  const prevStreak: Record<number, number> = {};
  // Transient membership → animation class; each id is removed once its animation has played.
  const justTicked = new SvelteSet<number>(); // leaf checkbox spring-fill
  const justSet = new SvelteSet<number>(); // set row + chip pulse
  const justMilestone = new SvelteSet<number>(); // streak-badge flourish

  function flash(bucket: SvelteSet<number>, id: number, ms: number) {
    bucket.add(id);
    setTimeout(() => bucket.delete(id), ms);
  }

  $effect(() => {
    if (reducedMotion) return;
    for (const node of flattenTree(tree)) {
      const id = node.item.id;
      const wasDone = prevDone[id];
      if (wasDone === false && node.done) flash(node.isSet ? justSet : justTicked, id, node.isSet ? 600 : 500);
      prevDone[id] = node.done;

      const streak = node.streak.current;
      const wasStreak = prevStreak[id];
      if (wasStreak !== undefined && wasStreak !== streak && isStreakMilestone(streak)) flash(justMilestone, id, 900);
      prevStreak[id] = streak;
    }
  });
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
        class:pulse={justSet.has(s.item.id)}
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
      <div
        class="set-row"
        class:done={node.done}
        class:animate-set={justSet.has(node.item.id)}
        class:animate-milestone={justMilestone.has(node.item.id)}
      >
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
        class:animate-tick={justTicked.has(node.item.id)}
        class:animate-milestone={justMilestone.has(node.item.id)}
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
    </li>
  {/if}
{/snippet}

<ul class="today-list" class:compact aria-label={isToday ? "Today's habits" : 'Habits for this day'}>
  {#each roots as node (node.item.id)}
    {@render renderNode(node)}
  {/each}

  {#if roots.length === 0 && loaded}
    <li class="empty">
      {#if !isToday}
        Nothing was due this day.
      {:else}
        {compact ? 'Nothing due today.' : 'Nothing due today — add or schedule a habit on the Habits tab.'}
      {/if}
    </li>
  {/if}
</ul>

{#if !compact && onMetric && selectedMetrics.length > 0}
  <section class="metrics" aria-label="Metrics">
    <h3>Metrics</h3>
    {#each selectedMetrics as metric (metric.item.id)}
      <MetricInput {metric} {onMetric} />
    {/each}
  </section>
{/if}

<style lang="scss" src="./TodayList.scss"></style>
