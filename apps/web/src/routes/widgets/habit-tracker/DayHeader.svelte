<script lang="ts">
  import { canStepForward, formatHabitDate, relativeDayLabel } from './day-nav';

  /**
   * The Today date header (PD-779 ([Habit Tracker] date header + day arrows on Today)), on both the
   * card and the page: the viewed habit day with its relative label ("Today", "Yesterday") where one
   * applies, a left arrow back one habit day, a right arrow forward one (disabled on today, so Today
   * never pages into the future), and a "Today" jump shown only off today.
   */
  let {
    day,
    today,
    onStep,
    onToday,
    compact = false,
  }: {
    day: string;
    today: string;
    onStep: (delta: -1 | 1) => void;
    onToday: () => void;
    compact?: boolean;
  } = $props();

  const relative = $derived(relativeDayLabel(day, today));
  const date = $derived(formatHabitDate(day, today));
  const forward = $derived(canStepForward(day, today));
</script>

<div class="day-header" class:compact>
  <button type="button" class="day-arrow" aria-label="Previous day" onclick={() => onStep(-1)}>‹</button>
  <h3 class="day-title" aria-live="polite">
    {#if relative}<span class="day-relative">{relative}</span>{/if}
    <span class="day-date">{date}</span>
  </h3>
  {#if day !== today}
    <button type="button" class="day-today" onclick={onToday}>Today</button>
  {/if}
  <button type="button" class="day-arrow" aria-label="Next day" disabled={!forward} onclick={() => onStep(1)}>›</button>
</div>

<style lang="scss" src="./DayHeader.scss"></style>
