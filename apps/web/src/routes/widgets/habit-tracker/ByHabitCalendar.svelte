<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    completionRate,
    habitDay,
    habitMonthSpans,
    habitWeekStart,
    habitWeeksEndingAt,
    HABIT_WEEKDAY_NAMES,
    setCompletionRate,
    setStreak,
    streak,
    addHabitDays,
    type CompletionRate,
    type HabitCompletion,
    type HabitItemView,
    type HabitSchedule,
    type HabitSettings,
    type StreakResult,
  } from '@dashboard/shared';
  import { fetchCompletions } from './api';
  import type { PendingHabitWrite } from './queue';
  import {
    buildDaySets,
    buildHistoryNode,
    buildItemOptions,
    groupSchedulesByItem,
    isSetItem,
    leafCellState,
    setCellState,
    subtreeItemIds,
    weekSpanCount,
    type CellState,
  } from './by-habit';

  /**
   * Log › By Habit (PD-726): a calendar for one item. A dropdown picks an active item (tree order)
   * or an archived one; the grid shows habit weeks (Mon–Sun) newest at the bottom, with month names
   * in a left gutter; the header shows streak + completion-rate stats (none for a metric).
   *
   * Reads completions directly (`fetchCompletions`), but every **write** is a set-state message on
   * the one shared outbox owned by `HabitTracker.svelte` — we call `onToggle`, never the write API
   * (PROJECT.md §4, D-093). Pending outbox writes are folded over the loaded completions so an
   * unsynced toggle doesn't revert (`buildDaySets`).
   */
  interface Props {
    items: HabitItemView[];
    schedules: HabitSchedule[];
    settings: HabitSettings;
    today: string;
    pending: PendingHabitWrite[];
    initialItemId?: number | null;
    onToggle: (itemId: number, day: string, done: boolean) => void;
  }

  let { items, schedules, settings, today, pending, initialItemId = null, onToggle }: Props = $props();

  const INITIAL_WEEKS = 12;
  const LOAD_THRESHOLD_PX = 48;
  const MAX_WEEKS = 520; // ~10 years; a safety cap on lazy loading

  const options = $derived(buildItemOptions(items));

  // Dropdown indentation: `<option>` collapses ordinary whitespace, so nested items are indented
  // with non-breaking spaces (two per depth level).
  const indent = (depth: number): string => '  '.repeat(depth);

  // The selected item id. Seeded from the deep link (`?view=habit&item=<id>`) when valid, else the
  // first active item, else the first archived one.
  let selectedId = $state<number | null>(null);
  $effect(() => {
    const ids = new Set(items.map((i) => i.id));
    if (selectedId !== null && ids.has(selectedId)) return;
    if (initialItemId !== null && ids.has(initialItemId)) selectedId = initialItemId;
    else selectedId = options.active[0]?.item.id ?? options.archived[0]?.id ?? null;
  });
  // Follow a *fresh* deep link even if something is already selected — but only once per link, so a
  // later server refresh of `items` can't snap the dropdown back after the user picked something else.
  let lastAppliedLink = $state<number | null>(null);
  $effect(() => {
    if (
      initialItemId !== null &&
      initialItemId !== lastAppliedLink &&
      items.some((i) => i.id === initialItemId)
    ) {
      selectedId = initialItemId;
      lastAppliedLink = initialItemId;
    }
  });

  const selected = $derived(items.find((i) => i.id === selectedId) ?? null);
  const isSet = $derived(selected ? isSetItem(items, selected.id) : false);
  const isMetric = $derived(selected?.kind === 'metric');

  // Completions are loaded once over a wide range (the table is small; the 2025 import predates
  // item creation, so we cannot floor at createdAt — D-102). Toggles mutate this list optimistically;
  // the outbox owns the durable write.
  let completions = $state<HabitCompletion[]>([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      completions = await fetchCompletions('2000-01-01', today);
    } catch {
      completions = [];
    } finally {
      loading = false;
    }
  });

  const schedulesByItem = $derived(groupSchedulesByItem(schedules));

  // The ids whose completions back the current view: just the leaf for a leaf, the whole subtree for
  // a set. Day-sets fold the outbox's pending writes over the loaded completions.
  const subtreeIds = $derived(selected ? subtreeItemIds(items, selected.id) : new Set<number>());
  const daySets = $derived(buildDaySets(completions, subtreeIds, pending));
  const selectedDays = $derived(selected ? (daySets.get(selected.id) ?? new Set<string>()) : new Set<string>());
  const selectedSchedules = $derived(selected ? (schedulesByItem.get(selected.id) ?? []) : []);
  const historyNode = $derived(
    selected && isSet ? buildHistoryNode(items, selected.id, schedulesByItem, daySets) : null,
  );

  // ── Header stats ──────────────────────────────────────────────
  const streakStat = $derived.by<StreakResult | null>(() => {
    if (!selected || isMetric) return null;
    return isSet && historyNode ? setStreak(historyNode, today) : streak(selectedSchedules, selectedDays, today);
  });
  const rateStat = $derived.by<CompletionRate | null>(() => {
    if (!selected || isMetric) return null;
    return isSet && historyNode
      ? setCompletionRate(historyNode, today)
      : completionRate(selectedSchedules, selectedDays, today);
  });
  const ratePct = $derived(rateStat && rateStat.rate !== null ? Math.round(rateStat.rate * 100) : null);

  // ── Calendar geometry ─────────────────────────────────────────
  const currentWeekStart = $derived(habitWeekStart(today));

  // The earliest week worth showing: the earliest of the subtree's creation and its first completion.
  const floorDay = $derived.by(() => {
    let floor = today;
    for (const it of items) {
      if (!subtreeIds.has(it.id)) continue;
      const created = habitDay(it.createdAt, settings);
      if (created < floor) floor = created;
    }
    for (const day of selectedDays) if (day < floor) floor = day;
    return floor;
  });
  const maxWeeks = $derived(Math.min(MAX_WEEKS, weekSpanCount(floorDay, today)));

  let weeksToShow = $state(INITIAL_WEEKS);
  // Reset the window whenever the selected item changes (not when its history reshapes).
  let windowFor = $state<number | null>(null);
  $effect(() => {
    if (selectedId !== windowFor) {
      windowFor = selectedId;
      weeksToShow = INITIAL_WEEKS;
    }
  });
  // Clamp to the item's history so we never render weeks before it existed.
  const effectiveWeeks = $derived(Math.max(1, Math.min(weeksToShow, maxWeeks)));
  const canLoadMore = $derived(effectiveWeeks < maxWeeks);

  const weekStarts = $derived(habitWeeksEndingAt(currentWeekStart, effectiveWeeks));
  const months = $derived(habitMonthSpans(weekStarts));

  interface Cell {
    day: string;
    row: number; // week index
    col: number; // weekday 0=Mon
    dayNum: number;
    state: CellState;
  }
  const cells = $derived.by<Cell[]>(() => {
    if (!selected) return [];
    const out: Cell[] = [];
    weekStarts.forEach((weekStart, row) => {
      for (let col = 0; col < 7; col += 1) {
        const day = addHabitDays(weekStart, col);
        const state: CellState = isMetric
          ? day > today
            ? 'future'
            : 'notdue'
          : isSet && historyNode
            ? setCellState(historyNode, day, today)
            : leafCellState(selectedSchedules, selectedDays, day, today);
        out.push({ day, row, col, dayNum: Number(day.slice(8, 10)), state });
      }
    });
    return out;
  });

  // ── Scrolling ─────────────────────────────────────────────────
  let scroller = $state<HTMLDivElement | null>(null);

  function scrollToBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // Open at the newest week (the bottom) on first load and whenever the item changes.
  $effect(() => {
    if (loading || selectedId === null) return;
    void tick().then(scrollToBottom);
  });

  // Scrolling up near the top lazy-loads one earlier week, preserving the viewport position.
  function onScroll(): void {
    if (!scroller || !canLoadMore) return;
    if (scroller.scrollTop > LOAD_THRESHOLD_PX) return;
    const before = scroller.scrollHeight;
    weeksToShow = Math.min(maxWeeks, weeksToShow + 1);
    void tick().then(() => {
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    });
  }

  function toggleCell(day: string): void {
    if (!selected || isSet || isMetric || day > today) return;
    const done = !selectedDays.has(day);
    // Optimistic local update; the outbox owns the durable, idempotent set-state write.
    completions = done
      ? [...completions, { itemId: selected.id, day, completedAt: Date.now() }]
      : completions.filter((c) => !(c.itemId === selected.id && c.day === day));
    onToggle(selected.id, day, done);
  }

  function cellLabel(cell: Cell): string {
    const base = `${selected?.name ?? ''} ${cell.day}`;
    return cell.state === 'done' || cell.state === 'extra' ? `Untick ${base}` : `Tick ${base}`;
  }
</script>

<div class="by-habit">
  <div class="controls">
    <label class="picker">
      <span class="picker-label">Item</span>
      <select bind:value={selectedId} aria-label="Choose a habit, set or metric">
        {#each options.active as opt (opt.item.id)}
          <option value={opt.item.id}>{indent(opt.depth)}{opt.item.name}</option>
        {/each}
        {#if options.archived.length > 0}
          <optgroup label="Archived">
            {#each options.archived as it (it.id)}
              <option value={it.id}>{it.name}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>

    {#if selected && !isMetric && streakStat}
      <dl class="stats" aria-label="Stats">
        <div class="stat"><dt>Current</dt><dd>🔥{streakStat.current}</dd></div>
        <div class="stat"><dt>Longest</dt><dd>{streakStat.longest}</dd></div>
        <div class="stat">
          <dt>Last {rateStat?.total ?? 0}</dt>
          <dd>{ratePct === null ? '—' : `${ratePct}%`}</dd>
        </div>
      </dl>
    {:else if isMetric}
      <p class="no-stats">Metrics have no streak stats.</p>
    {/if}
  </div>

  {#if options.active.length === 0 && options.archived.length === 0}
    <p class="empty">No habits yet — add one on the Habits tab.</p>
  {:else if selected}
    <div class="scroller" bind:this={scroller} onscroll={onScroll}>
      <div class="calendar" role="grid" aria-label={`${selected.name} calendar`}>
        <div class="corner" aria-hidden="true"></div>
        {#each HABIT_WEEKDAY_NAMES as name, col (name)}
          <div class="weekday" style={`grid-column:${col + 2}`} role="columnheader">{name}</div>
        {/each}

        {#each months as m (`${m.year}-${m.month}`)}
          <div class="month" style={`grid-row:${m.startRow + 2}/${m.endRow + 3}`}>
            <span class="month-name">{m.monthName}</span>
            {#if m.month === 1}<span class="month-year">{m.year}</span>{/if}
            <span class="month-line" aria-hidden="true"></span>
          </div>
        {/each}

        {#each cells as cell (cell.day)}
          {#if cell.state === 'future'}
            <div class="cell future" style={`grid-row:${cell.row + 2};grid-column:${cell.col + 2}`}></div>
          {:else if isSet || isMetric}
            <div
              class="cell {cell.state}"
              style={`grid-row:${cell.row + 2};grid-column:${cell.col + 2}`}
              role="gridcell"
            >
              <span class="day-num">{cell.dayNum}</span>
            </div>
          {:else}
            <button
              type="button"
              class="cell {cell.state}"
              style={`grid-row:${cell.row + 2};grid-column:${cell.col + 2}`}
              aria-label={cellLabel(cell)}
              aria-pressed={cell.state === 'done' || cell.state === 'extra'}
              onclick={() => toggleCell(cell.day)}
            >
              <span class="day-num">{cell.dayNum}</span>
            </button>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style lang="scss" src="./ByHabitCalendar.scss"></style>
