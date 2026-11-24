<script lang="ts">
  import { tick } from 'svelte';
  import {
    energyColor,
    energyLabel,
    habitMonthSpans,
    habitWeekStart,
    habitWeeksEndingAt,
    moodLabel,
    scale15Color,
    HABIT_WEEKDAY_NAMES,
    MOOD_ENERGY_MAX,
    SCALE_1_5_INK,
  } from '@dashboard/shared';
  import { buildCells, weekSpanCount, type DayCell } from './calendar';
  import { formatDay, type DayEntry } from './days';

  /**
   * Log › calendar: Monday–Sunday rows, newest week at the bottom, month names in a left gutter —
   * the Habit Tracker's By Habit layout on the same shared week helpers. Each day is shaded by mood
   * (the shared red→green scale) with a bar along the bottom for energy (its own blue ramp, width =
   * energy). Tapping a day opens it; tapping an empty day starts one.
   *
   * An adapted copy of `habit-tracker/ByHabitCalendar.svelte` (no cross-widget imports).
   */
  interface Props {
    entries: DayEntry[];
    today: string;
    onOpen: (day: string, entry: DayEntry | null) => void;
  }

  let { entries, today, onOpen }: Props = $props();

  const INITIAL_WEEKS = 8;
  const MORE_WEEKS = 4;
  const LOAD_THRESHOLD_PX = 48;
  const MAX_WEEKS = 520;

  const byDay = $derived(new Map(entries.map((e) => [e.day, e])));
  const oldest = $derived(entries.reduce((min, e) => (e.day < min ? e.day : min), today));
  // A few weeks before the first entry are always reachable, so a missed day can be backfilled.
  const maxWeeks = $derived(Math.min(MAX_WEEKS, weekSpanCount(oldest, today) + MORE_WEEKS));

  let weeksToShow = $state(INITIAL_WEEKS);
  const effectiveWeeks = $derived(Math.max(1, Math.min(weeksToShow, maxWeeks)));
  const canLoadMore = $derived(effectiveWeeks < maxWeeks);

  const weekStarts = $derived(habitWeeksEndingAt(habitWeekStart(today), effectiveWeeks));
  const months = $derived(habitMonthSpans(weekStarts));
  const cells = $derived(buildCells(weekStarts, byDay, today));

  let scroller = $state<HTMLDivElement | null>(null);
  let opened = false;

  // Open at the newest week (the bottom), once.
  $effect(() => {
    if (opened || !scroller) return;
    opened = true;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  /** Add earlier weeks above, keeping the viewport where it was. */
  function loadEarlier(n: number): void {
    if (!scroller || !canLoadMore) return;
    const before = scroller.scrollHeight;
    weeksToShow = Math.min(maxWeeks, effectiveWeeks + n);
    void tick().then(() => {
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    });
  }

  function onScroll(): void {
    if (scroller && scroller.scrollTop <= LOAD_THRESHOLD_PX) loadEarlier(1);
  }

  const moodGradient = `linear-gradient(90deg, ${scale15Color(1)}, ${scale15Color(3)}, ${scale15Color(5)})`;

  function cellLabel(c: DayCell): string {
    const day = formatDay(c.day, { year: true });
    if (!c.entry) return `Log ${day}`;
    return `${day}: mood ${c.entry.mood}, ${moodLabel(c.entry.mood)}; energy ${c.entry.energy}, ${energyLabel(c.entry.energy)}`;
  }
</script>

<div class="calendar-wrap">
  {#if canLoadMore}
    <button type="button" class="earlier" onclick={() => loadEarlier(MORE_WEEKS)}>Earlier weeks</button>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="calendar" role="grid" aria-label="Days by mood and energy">
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

      {#each cells as c (c.day)}
        {#if c.future}
          <div class="cell future" style={`grid-row:${c.row + 2};grid-column:${c.col + 2}`}></div>
        {:else}
          <button
            type="button"
            class="cell"
            class:filled={c.entry !== null}
            class:pending={c.entry?.pending}
            class:today={c.day === today}
            style={`grid-row:${c.row + 2};grid-column:${c.col + 2}`}
            style:--mood={c.entry ? scale15Color(c.entry.mood) : null}
            style:--mood-ink={SCALE_1_5_INK}
            style:--energy={c.entry ? energyColor(c.entry.energy) : null}
            style:--energy-pct={c.entry ? (c.entry.energy / MOOD_ENERGY_MAX) * 100 : 0}
            aria-label={cellLabel(c)}
            onclick={() => onOpen(c.day, c.entry)}
          >
            <span class="day-num">{c.dayNum}</span>
            {#if c.entry}<span class="energy" aria-hidden="true"></span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
  <div class="legend" aria-hidden="true">
    <span><i class="key-mood" style:background={moodGradient}></i>Shade: mood</span>
    <span><i class="key-energy" style:background={energyColor(4)}></i>Bar: energy</span>
  </div>
</div>

<style lang="scss" src="./DayCalendar.scss"></style>
