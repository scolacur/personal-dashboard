<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    addHabitDays,
    HABIT_MONTH_NAMES,
    type HabitChoiceOption,
    type HabitCompletion,
    type HabitHistoryNode,
    type HabitItemView,
    type HabitMetricTodayRow,
    type HabitMetricValue,
    type HabitSchedule,
  } from '@dashboard/shared';
  import { fetchCompletions, fetchMetricValues } from './api';
  import {
    buildDaySets,
    buildHistoryNode,
    groupSchedulesByItem,
    leafCellState,
    setCellState,
    type CellState,
  } from './by-habit';
  import {
    applyCompletionWrite,
    buildDayRows,
    buildMetricValueMap,
    formatMetricCell,
    habitDaysBetween,
    setDayShortcut,
    type DayRow,
  } from './by-day';
  import type { PendingHabitWrite } from './queue';
  import MetricInput from './MetricInput.svelte';

  /**
   * Log › By Day (PD-725): a grid for scanning history and fixing past days. Items are rows (sets
   * above their children, metrics below), habit days the other axis. The grid opens at today and
   * lazy-loads older days 30 at a time through the range endpoints (`from`/`to`); a **Flip axes**
   * button swaps rows and columns, remembered per device. Default orientation: days as columns, today
   * rightmost. Flipped: days as rows, today at the top.
   *
   * Every cell write is an idempotent set-state message on the one shared outbox owned by
   * `HabitTracker.svelte` (PROJECT.md §4, D-093): a habit/set tap calls `onToggle`, a metric edit
   * calls `onMetricWrite` — never the write API directly. Pending outbox writes are folded over the
   * loaded completions / values so an unsynced edit does not visually revert.
   */
  interface Props {
    items: HabitItemView[];
    schedules: HabitSchedule[];
    today: string;
    pending: PendingHabitWrite[];
    /** Active metrics with their options (from the Today view), so a choice cell can offer them. */
    metricRows: HabitMetricTodayRow[];
    /** A day to scroll to on open (`?view=day&day=YYYY-MM-DD`), e.g. the yesterday banner. */
    initialDay?: string | null;
    onToggle: (itemId: number, day: string, done: boolean) => void;
    onMetricWrite: (itemId: number, day: string, value: string | null) => void;
    /** Open Log › By Habit for an item (its row-header name). Omit to render names as plain text. */
    onOpenItem?: (itemId: number) => void;
  }

  let {
    items,
    schedules,
    today,
    pending,
    metricRows,
    initialDay = null,
    onToggle,
    onMetricWrite,
    onOpenItem,
  }: Props = $props();

  const CHUNK_DAYS = 30;
  const LOAD_THRESHOLD_PX = 48;
  const MIN_DAY = '2000-01-01'; // a floor on lazy loading, matching By Habit's history floor

  const FLIP_KEY = 'habit-tracker:by-day-flipped';
  function loadFlipped(): boolean {
    try {
      return localStorage.getItem(FLIP_KEY) === '1';
    } catch {
      return false;
    }
  }
  let flipped = $state(loadFlipped());
  function toggleFlip(): void {
    flipped = !flipped;
    try {
      localStorage.setItem(FLIP_KEY, flipped ? '1' : '0');
    } catch {
      /* private mode / blocked storage: the choice just won't persist. */
    }
  }

  const defaultStart = addHabitDays(today, -(CHUNK_DAYS - 1));
  let loadedFrom = $state(defaultStart);
  let completions = $state<HabitCompletion[]>([]);
  let metricValues = $state<HabitMetricValue[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);

  onMount(async () => {
    let from = defaultStart;
    if (initialDay && initialDay < from && initialDay >= MIN_DAY) from = initialDay;
    loadedFrom = from;
    try {
      const [c, m] = await Promise.all([fetchCompletions(from, today), fetchMetricValues(from, today)]);
      completions = c;
      metricValues = m;
    } catch {
      completions = [];
      metricValues = [];
    } finally {
      loading = false;
    }
  });

  const canLoadMore = $derived(loadedFrom > MIN_DAY);

  /** Fetch the previous 30-day chunk and prepend it to the loaded window. */
  async function loadOlder(): Promise<void> {
    if (loadingMore || !canLoadMore) return;
    loadingMore = true;
    const to = addHabitDays(loadedFrom, -1);
    let from = addHabitDays(loadedFrom, -CHUNK_DAYS);
    if (from < MIN_DAY) from = MIN_DAY;
    try {
      const [c, m] = await Promise.all([fetchCompletions(from, to), fetchMetricValues(from, to)]);
      completions = [...completions, ...c];
      metricValues = [...metricValues, ...m];
      loadedFrom = from;
    } catch {
      /* leave the window as-is; the next scroll retries. */
    } finally {
      loadingMore = false;
    }
  }

  // ── Derived grid data ─────────────────────────────────────────
  const rows = $derived(buildDayRows(items));
  const days = $derived(habitDaysBetween(loadedFrom, today)); // oldest first
  // Days as rows (flipped) show today at the top → newest first.
  const rowDays = $derived(flipped ? [...days].reverse() : days);

  const allIds = $derived(new Set(items.map((i) => i.id)));
  const schedulesByItem = $derived(groupSchedulesByItem(schedules));
  const daySets = $derived(buildDaySets(completions, allIds, pending));
  const metricValueMap = $derived(buildMetricValueMap(metricValues, pending));
  // Constructor-form maps (no post-construction `.set`), so they stay plain derivations.
  const metricOptions = $derived(
    new Map<number, HabitChoiceOption[]>(metricRows.map((mr) => [mr.item.id, mr.options])),
  );
  const metricTypeOf = $derived(new Map(items.map((i) => [i.id, i.metricType])));
  const historyNodes = $derived(
    new Map<number, HabitHistoryNode>(
      rows
        .filter((r) => r.isSet)
        .map((r) => [r.item.id, buildHistoryNode(items, r.item.id, schedulesByItem, daySets)]),
    ),
  );

  const EMPTY = new Set<string>();
  function habitCellState(row: DayRow, day: string): CellState {
    if (row.isSet) {
      const node = historyNodes.get(row.item.id);
      return node ? setCellState(node, day, today) : 'notdue';
    }
    return leafCellState(schedulesByItem.get(row.item.id) ?? [], daySets.get(row.item.id) ?? EMPTY, day, today);
  }

  function metricCellText(itemId: number, day: string): string {
    const value = metricValueMap.get(itemId)?.get(day) ?? null;
    return formatMetricCell(value, metricTypeOf.get(itemId) ?? null, metricOptions.get(itemId) ?? []);
  }

  // Short column/row header for a day: the day-of-month, with the month prefixed on its first day.
  function dayHeaderLabel(day: string): string {
    const [, m, d] = day.split('-').map(Number);
    const dayNum = String(d);
    return d === 1 || day === loadedFrom ? `${HABIT_MONTH_NAMES[m - 1]} ${dayNum}` : dayNum;
  }

  // ── Cell interactions (all via the shared outbox) ─────────────
  function onHabitCell(row: DayRow, day: string): void {
    if (row.isMetric) return;
    if (row.isSet) {
      const writes = setDayShortcut(items, schedulesByItem, daySets, row.item.id, day);
      for (const w of writes) writeCompletion(w.leafId, day, w.done);
      return;
    }
    const done = !(daySets.get(row.item.id)?.has(day) ?? false);
    writeCompletion(row.item.id, day, done);
  }

  // Optimistic local update first — the pending overlay vanishes once the outbox flushes, so the
  // loaded completions must carry the new state too (PD-972). The outbox owns the durable write.
  function writeCompletion(itemId: number, day: string, done: boolean): void {
    completions = applyCompletionWrite(completions, itemId, day, done);
    onToggle(itemId, day, done);
  }

  function cellLabel(row: DayRow, day: string, state: CellState): string {
    const done = state === 'done' || state === 'extra';
    return `${done ? 'Untick' : 'Tick'} ${row.item.name} ${day}`;
  }

  // ── Metric inline editor ──────────────────────────────────────
  let editing = $state<{ itemId: number; day: string; top: number; left: number } | null>(null);
  const editingRow = $derived.by<HabitMetricTodayRow | null>(() => {
    const e = editing;
    if (!e) return null;
    const item = items.find((i) => i.id === e.itemId);
    if (!item) return null;
    const value = metricValueMap.get(e.itemId)?.get(e.day) ?? null;
    return { item, value, options: metricOptions.get(e.itemId) ?? [] };
  });

  function openMetricEditor(e: MouseEvent, itemId: number, day: string): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - 260);
    editing = { itemId, day, top: rect.bottom + 4, left: Math.max(8, left) };
  }

  function closeEditor(): void {
    editing = null;
  }

  function onEditorKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeEditor();
  }

  // ── Scrolling: lazy-load + open position ──────────────────────
  let scroller = $state<HTMLDivElement | null>(null);
  // A plain lookup of day → header element for scroll positioning (not reactive state).
  const dayEls: Record<string, HTMLElement> = {};
  function dayRef(node: HTMLElement, day: string) {
    dayEls[day] = node;
    return {
      update(next: string) {
        delete dayEls[day];
        day = next;
        dayEls[day] = node;
      },
      destroy() {
        delete dayEls[day];
      },
    };
  }

  function scrollToDay(day: string): void {
    const el = dayEls[day];
    if (!el) return;
    if (flipped) el.scrollIntoView({ block: day === today ? 'start' : 'center', inline: 'nearest' });
    else el.scrollIntoView({ block: 'nearest', inline: day === today ? 'end' : 'center' });
  }

  async function onScroll(): Promise<void> {
    if (!scroller || loadingMore || !canLoadMore) return;
    if (flipped) {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < LOAD_THRESHOLD_PX;
      if (nearBottom) await loadOlder();
    } else {
      if (scroller.scrollLeft > LOAD_THRESHOLD_PX) return;
      const before = scroller.scrollWidth;
      await loadOlder();
      await tick();
      // Prepending columns grows the content to the left; keep the viewport where it was.
      if (scroller) scroller.scrollLeft += scroller.scrollWidth - before;
    }
  }

  // Position at the focus day (the deep-linked day when loaded, else today) once loaded, and again
  // whenever the orientation flips. Keyed so it fires once per (orientation, focus) pair.
  let positionedKey = $state<string | null>(null);
  $effect(() => {
    if (loading) return;
    const focus = initialDay && loadedFrom <= initialDay && initialDay <= today ? initialDay : today;
    const key = `${flipped}:${focus}`;
    if (positionedKey === key) return;
    positionedKey = key;
    void tick().then(() => scrollToDay(focus));
  });
</script>

<div class="by-day">
  <div class="toolbar">
    <button type="button" class="flip" onclick={toggleFlip}>
      Flip axes <span class="flip-state">({flipped ? 'days as rows' : 'days as columns'})</span>
    </button>
    {#if loadingMore}<span class="loading-more" role="status">Loading…</span>{/if}
  </div>

  {#if loading}
    <p class="empty">Loading history…</p>
  {:else if rows.length === 0}
    <p class="empty">No habits yet — add one on the Habits tab.</p>
  {:else}
    <div
      class="scroller"
      class:flipped
      bind:this={scroller}
      onscroll={onScroll}
    >
      {#if flipped}
        <!-- Days as rows (today at the top), items as columns. -->
        <div
          class="grid"
          role="grid"
          aria-label="Habit history by day"
          style={`grid-template-columns: var(--daycol) repeat(${rows.length}, minmax(3rem, 1fr));`}
        >
          <div class="corner" style="grid-row:1;grid-column:1"></div>
          {#each rows as row, c (row.item.id)}
            <div class="col-head" class:metric={row.isMetric} style={`grid-row:1;grid-column:${c + 2}`} role="columnheader">
              {#if onOpenItem}
                <button type="button" class="name-link" onclick={() => onOpenItem?.(row.item.id)} title={`Open ${row.item.name} in By Habit`}>{row.item.name}</button>
              {:else}
                <span class="name">{row.item.name}</span>
              {/if}
            </div>
          {/each}

          {#each rowDays as day, r (day)}
            <div class="row-head day" class:today={day === today} style={`grid-row:${r + 2};grid-column:1`} role="rowheader" use:dayRef={day}>
              {dayHeaderLabel(day)}
            </div>
            {#each rows as row, c (row.item.id)}
              {@render cell(row, day, r + 2, c + 2)}
            {/each}
          {/each}
        </div>
      {:else}
        <!-- Days as columns (today rightmost), items as rows. -->
        <div
          class="grid"
          role="grid"
          aria-label="Habit history by day"
          style={`grid-template-columns: var(--namecol) repeat(${days.length}, minmax(2.25rem, 1fr));`}
        >
          <div class="corner" style="grid-row:1;grid-column:1"></div>
          {#each days as day, c (day)}
            <div class="col-head day" class:today={day === today} style={`grid-row:1;grid-column:${c + 2}`} role="columnheader" use:dayRef={day}>
              {dayHeaderLabel(day)}
            </div>
          {/each}

          {#each rows as row, r (row.item.id)}
            <div
              class="row-head name-cell"
              class:metric={row.isMetric}
              style={`grid-row:${r + 2};grid-column:1;padding-left:calc(var(--space-sm) + ${row.depth} * var(--space-md))`}
              role="rowheader"
            >
              {#if onOpenItem}
                <button type="button" class="name-link" onclick={() => onOpenItem?.(row.item.id)} title={`Open ${row.item.name} in By Habit`}>{row.item.name}</button>
              {:else}
                <span class="name">{row.item.name}</span>
              {/if}
            </div>
            {#each days as day, c (day)}
              {@render cell(row, day, r + 2, c + 2)}
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

{#snippet cell(row: DayRow, day: string, gridRow: number, gridColumn: number)}
  {#if row.isMetric}
    {@const text = metricCellText(row.item.id, day)}
    <button
      type="button"
      class="cell metric-cell"
      class:logged={text !== ''}
      style={`grid-row:${gridRow};grid-column:${gridColumn}`}
      aria-label={`Edit ${row.item.name} ${day}`}
      onclick={(e) => openMetricEditor(e, row.item.id, day)}
    >
      <span class="metric-value">{text}</span>
    </button>
  {:else}
    {@const state = habitCellState(row, day)}
    <button
      type="button"
      class="cell {state}"
      style={`grid-row:${gridRow};grid-column:${gridColumn}`}
      aria-label={cellLabel(row, day, state)}
      aria-pressed={state === 'done' || state === 'extra'}
      onclick={() => onHabitCell(row, day)}
    ></button>
  {/if}
{/snippet}

{#if editing && editingRow}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="editor-backdrop" onclick={closeEditor}></div>
  <div
    class="metric-editor"
    style={`top:${editing.top}px;left:${editing.left}px`}
    role="dialog"
    tabindex="-1"
    aria-label={`${editingRow.item.name} on ${editing.day}`}
    onkeydown={onEditorKeydown}
  >
    <div class="editor-head">
      <span class="editor-day">{editing.day}</span>
      <button type="button" class="editor-close" onclick={closeEditor} aria-label="Close">×</button>
    </div>
    <MetricInput metric={editingRow} onMetric={(id, value) => onMetricWrite(id, editing!.day, value)} />
  </div>
{/if}

<style lang="scss" src="./ByDayGrid.scss"></style>
