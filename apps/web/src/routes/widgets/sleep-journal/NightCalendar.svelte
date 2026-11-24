<script lang="ts">
  import { tick } from 'svelte';
  import {
    habitMonthSpans,
    habitWeekStart,
    habitWeeksEndingAt,
    HABIT_WEEKDAY_NAMES,
    scale15Color,
    sleepRestedLabel,
    SCALE_1_5_INK,
    type SleepEntry,
  } from '@dashboard/shared';
  import { buildCells, weekSpanCount, type NightCell } from './calendar';
  import { formatWakeDate } from './time';

  /**
   * History › calendar: Monday–Sunday rows, newest week at the bottom, month names in a left gutter
   * — the Habit Tracker's By Habit layout, built on the same shared week helpers. Each night is
   * shaded by its rested score; tapping one opens it, tapping an empty night starts one for that date.
   *
   * An adapted copy of `habit-tracker/ByHabitCalendar.svelte` (no cross-widget imports); lifting a
   * generic week calendar into `$lib` is a follow-up.
   */
  interface Props {
    entries: SleepEntry[];
    today: string;
    onOpen: (date: string, entry: SleepEntry | null) => void;
  }

  let { entries, today, onOpen }: Props = $props();

  const INITIAL_WEEKS = 8;
  const MORE_WEEKS = 4;
  const LOAD_THRESHOLD_PX = 48;
  const MAX_WEEKS = 520;

  const byDate = $derived(new Map(entries.map((e) => [e.wakeDate, e])));
  const oldest = $derived(entries.reduce((min, e) => (e.wakeDate < min ? e.wakeDate : min), today));
  // Always allow a few weeks before the first night, so a missed night can be backfilled.
  const maxWeeks = $derived(Math.min(MAX_WEEKS, weekSpanCount(oldest, today) + MORE_WEEKS));

  let weeksToShow = $state(INITIAL_WEEKS);
  const effectiveWeeks = $derived(Math.max(1, Math.min(weeksToShow, maxWeeks)));
  const canLoadMore = $derived(effectiveWeeks < maxWeeks);

  const weekStarts = $derived(habitWeeksEndingAt(habitWeekStart(today), effectiveWeeks));
  const months = $derived(habitMonthSpans(weekStarts));
  const cells = $derived(buildCells(weekStarts, byDate, today));

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

  function cellLabel(c: NightCell): string {
    const day = formatWakeDate(c.date, { year: true });
    return c.entry ? `Night of ${day}: ${c.entry.rested}, ${sleepRestedLabel(c.entry.rested)}` : `Log the night of ${day}`;
  }
</script>

<div class="calendar-wrap">
  {#if canLoadMore}
    <button type="button" class="earlier" onclick={() => loadEarlier(MORE_WEEKS)}>Earlier weeks</button>
  {/if}
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    <div class="calendar" role="grid" aria-label="Nights by rested score">
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

      {#each cells as c (c.date)}
        {#if c.future}
          <div class="cell future" style={`grid-row:${c.row + 2};grid-column:${c.col + 2}`}></div>
        {:else}
          <button
            type="button"
            class="cell"
            class:filled={c.entry !== null}
            class:today={c.date === today}
            style={`grid-row:${c.row + 2};grid-column:${c.col + 2}`}
            style:--rested={c.entry ? scale15Color(c.entry.rested) : null}
            style:--rested-ink={SCALE_1_5_INK}
            aria-label={cellLabel(c)}
            onclick={() => onOpen(c.date, c.entry)}
          >
            <span class="day-num">{c.dayNum}</span>
          </button>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style lang="scss" src="./NightCalendar.scss"></style>
