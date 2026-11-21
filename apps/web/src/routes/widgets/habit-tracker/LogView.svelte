<script lang="ts">
  import type { HabitItemView, HabitMetricTodayRow, HabitSchedule, HabitSettings } from '@dashboard/shared';
  import type { PendingHabitWrite } from './queue';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import ByHabitCalendar from './ByHabitCalendar.svelte';
  import ByDayGrid from './ByDayGrid.svelte';

  /**
   * The Log tab (PD-725 / PD-726), with two views: **By Day** (a grid of days, PD-725) and **By
   * Habit** (a calendar for one item, PD-726). The active view is seeded from the deep link
   * (`?view=day&day=<YYYY-MM-DD>` or `?view=habit&item=<id>`, read by `HabitTracker.svelte`) and
   * otherwise defaults to By Day.
   */
  interface Props {
    items: HabitItemView[];
    schedules: HabitSchedule[];
    settings: HabitSettings;
    today: string;
    pending: PendingHabitWrite[];
    metricRows: HabitMetricTodayRow[];
    initialView?: 'day' | 'habit';
    initialItemId?: number | null;
    initialDay?: string | null;
    onToggle: (itemId: number, day: string, done: boolean) => void;
    onMetricWrite: (itemId: number, day: string, value: string | null) => void;
    onOpenItem: (itemId: number) => void;
  }

  let {
    items,
    schedules,
    settings,
    today,
    pending,
    metricRows,
    initialView = 'day',
    initialItemId = null,
    initialDay = null,
    onToggle,
    onMetricWrite,
    onOpenItem,
  }: Props = $props();

  // A writable `$derived`: `view` follows the deep link (`initialView`) and resets to it whenever a
  // new link arrives, but the view-switch buttons can override it locally in between.
  let view = $derived<'day' | 'habit'>(initialView);

  const VIEWS: { value: 'day' | 'habit'; label: string }[] = [
    { value: 'day', label: 'By Day' },
    { value: 'habit', label: 'By Habit' },
  ];
</script>

<div class="log-view">
  <SegmentedToggle
    label="Log view"
    options={VIEWS}
    value={view}
    onChange={(v) => (view = v)} />

  {#if view === 'habit'}
    <ByHabitCalendar {items} {schedules} {settings} {today} {pending} {initialItemId} {onToggle} />
  {:else}
    <ByDayGrid
      {items}
      {schedules}
      {today}
      {pending}
      {metricRows}
      {initialDay}
      {onToggle}
      {onMetricWrite}
      {onOpenItem} />
  {/if}
</div>

<style lang="scss" src="./LogView.scss"></style>
