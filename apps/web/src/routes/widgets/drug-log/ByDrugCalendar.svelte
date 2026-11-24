<script lang="ts">
  import { tick } from 'svelte';
  import {
    contrastText,
    habitDay,
    habitMonthSpans,
    habitWeekStart,
    habitWeeksEndingAt,
    HABIT_WEEKDAY_NAMES,
    type DrugLogDrug,
    type DrugLogEvent,
    type HabitSettings,
  } from '@dashboard/shared';
  import EventList from './EventList.svelte';
  import EventEditModal from './EventEditModal.svelte';
  import { fetchEvents } from './api';
  import {
    activeDrugs,
    archivedDrugs,
    calendarCells,
    cellIntensity,
    countsByDay,
    dayLabel,
    drugStats,
    formatAgo,
    mergeEvents,
    weekSpanCount,
    type CalendarCell,
  } from './drug-log';

  /**
   * Log › By Drug (PD-975, Drug log widget), modelled on the Habit Tracker's By Habit calendar: a
   * dropdown of drugs (active, then archived), Mon–Sun week rows with the newest at the bottom and
   * a month gutter, lazy-loading earlier weeks on scroll up. Each cell shows the day's count,
   * shaded in the drug's colour by how busy the day was. Tapping a cell lists that day's events
   * below the calendar for editing.
   */
  interface Props {
    drugs: DrugLogDrug[];
    settings: HabitSettings;
    today: string;
    onChanged: () => void;
  }

  let { drugs, settings, today, onChanged }: Props = $props();

  const INITIAL_WEEKS = 12;
  const LOAD_THRESHOLD_PX = 48;
  const MAX_WEEKS = 520;

  const active = $derived(activeDrugs(drugs));
  const archived = $derived(archivedDrugs(drugs));
  const drugsById = $derived(new Map(drugs.map((d) => [d.id, d])));

  let selectedId = $state<number | null>(null);
  $effect(() => {
    if (selectedId !== null && drugsById.has(selectedId)) return;
    selectedId = active[0]?.id ?? archived[0]?.id ?? null;
  });
  const selected = $derived(selectedId === null ? null : (drugsById.get(selectedId) ?? null));

  let events = $state<DrugLogEvent[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let loadedFor = $state<number | null>(null);

  async function load(id: number): Promise<void> {
    loading = true;
    failed = false;
    try {
      const got = await fetchEvents({ drugId: id, limit: 10_000 });
      if (selectedId === id) events = got;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  let weeksToShow = $state(INITIAL_WEEKS);
  let openDay = $state<string | null>(null);

  $effect(() => {
    if (selectedId === null || selectedId === loadedFor) return;
    loadedFor = selectedId;
    events = [];
    weeksToShow = INITIAL_WEEKS;
    openDay = null;
    void load(selectedId);
  });

  const counts = $derived(countsByDay(events, selectedId ?? -1, settings));

  // ── Geometry ──
  const floorDay = $derived.by(() => {
    let floor = today;
    for (const day of counts.keys()) if (day < floor) floor = day;
    return floor;
  });
  const maxWeeks = $derived(
    Math.min(MAX_WEEKS, Math.max(INITIAL_WEEKS, weekSpanCount(floorDay, today))),
  );
  const effectiveWeeks = $derived(Math.max(1, Math.min(weeksToShow, maxWeeks)));
  const canLoadMore = $derived(effectiveWeeks < maxWeeks);
  const weekStarts = $derived(habitWeeksEndingAt(habitWeekStart(today), effectiveWeeks));
  const months = $derived(habitMonthSpans(weekStarts));
  const cells = $derived(calendarCells(weekStarts, counts, today));
  const maxCount = $derived(cells.reduce((m, c) => Math.max(m, c.count), 0));

  // ── Stats ──
  const stats = $derived(drugStats(counts, weekStarts[0] ?? today, today));
  const lastAt = $derived(events.length > 0 ? Math.max(...events.map((e) => e.recordedAt)) : null);

  // ── Scrolling ──
  let scroller = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (loading || selectedId === null) return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  function onScroll(): void {
    if (!scroller || !canLoadMore || scroller.scrollTop > LOAD_THRESHOLD_PX) return;
    const before = scroller.scrollHeight;
    weeksToShow = Math.min(maxWeeks, effectiveWeeks + 1);
    void tick().then(() => {
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    });
  }

  function cellStyle(cell: CalendarCell): string {
    const pos = `grid-row:${cell.row + 2};grid-column:${cell.col + 2}`;
    const t = cellIntensity(cell.count, maxCount);
    if (!selected || t === 0) return pos;
    const fg = t >= 0.65 ? contrastText(selected.color) : 'var(--text)';
    return `${pos};background:color-mix(in srgb, ${selected.color} ${Math.round(t * 100)}%, var(--surface));border-color:${selected.color};color:${fg}`;
  }

  // ── The open day's events ──
  const dayEvents = $derived(
    openDay === null ? [] : events.filter((e) => habitDay(e.recordedAt, settings) === openDay),
  );

  let modalOpen = $state(false);
  let editing = $state<DrugLogEvent | null>(null);

  function saved(e: DrugLogEvent): void {
    events =
      e.drugId === selectedId ? mergeEvents(events, [e]) : events.filter((x) => x.id !== e.id);
    modalOpen = false;
    onChanged();
  }

  function deleted(id: number): void {
    events = events.filter((e) => e.id !== id);
    modalOpen = false;
    onChanged();
  }
</script>

<div class="by-drug">
  <div class="controls">
    <label class="picker">
      <span class="picker-label">Drug</span>
      <select bind:value={selectedId} aria-label="Choose a drug">
        {#each active as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
        {#if archived.length > 0}
          <optgroup label="Archived">
            {#each archived as d (d.id)}
              <option value={d.id}>{d.label}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>

    {#if selected}
      <dl class="stats" aria-label="Stats">
        <div class="stat">
          <dt>Total ({effectiveWeeks} wk)</dt>
          <dd>{stats.totalInRange}</dd>
        </div>
        <div class="stat">
          <dt>Days, last 30</dt>
          <dd>{stats.daysUsedLast30}</dd>
        </div>
        <div class="stat">
          <dt>Avg / active day</dt>
          <dd>{stats.avgPerActiveDay ?? '—'}</dd>
        </div>
        <div class="stat">
          <dt>Streak</dt>
          <dd>{stats.currentStreak}</dd>
        </div>
        <div class="stat">
          <dt>Longest</dt>
          <dd>{stats.longestStreak}</dd>
        </div>
        <div class="stat">
          <dt>Last</dt>
          <dd>{lastAt === null ? '—' : formatAgo(lastAt, Date.now())}</dd>
        </div>
      </dl>
    {/if}
  </div>

  {#if !selected}
    <p class="note">No drugs yet — add a button on the Buttons tab.</p>
  {:else}
    {#if failed}<p class="note">Couldn't load this drug's history.</p>{/if}
    <div class="scroller" bind:this={scroller} onscroll={onScroll}>
      <div class="calendar" role="grid" aria-label={`${selected.label} calendar`}>
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
          {#if cell.future}
            <div
              class="cell future"
              style={`grid-row:${cell.row + 2};grid-column:${cell.col + 2}`}
            ></div>
          {:else}
            <button
              type="button"
              class="cell"
              class:has={cell.count > 0}
              class:open={openDay === cell.day}
              style={cellStyle(cell)}
              aria-label={`${dayLabel(cell.day, today)}: ${cell.count} ${selected.label}`}
              aria-pressed={openDay === cell.day}
              onclick={() => (openDay = openDay === cell.day ? null : cell.day)}
            >
              <span class="day-num">{cell.dayNum}</span>
              {#if cell.count > 0}<span class="count">{cell.count}</span>{/if}
            </button>
          {/if}
        {/each}
      </div>
    </div>

    {#if openDay}
      <section class="day-panel" aria-label={`Entries on ${dayLabel(openDay, today)}`}>
        <h3>{dayLabel(openDay, today)}</h3>
        <EventList
          events={dayEvents}
          {drugsById}
          onEdit={(e) => {
            editing = e;
            modalOpen = true;
          }}
        />
      </section>
    {/if}
  {/if}

  <EventEditModal
    open={modalOpen}
    event={editing}
    {drugs}
    onClose={() => (modalOpen = false)}
    onSaved={saved}
    onDeleted={deleted}
  />
</div>

<style lang="scss" src="./ByDrugCalendar.scss"></style>
