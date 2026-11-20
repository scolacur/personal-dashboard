<script lang="ts">
  import type { HabitItemView, HabitSchedule, HabitSettings } from '@dashboard/shared';
  import type { PendingHabitWrite } from './queue';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import ByHabitCalendar from './ByHabitCalendar.svelte';

  /**
   * The Log tab (PD-725 / PD-726), with two views: **By Day** (a grid of days, PD-725) and **By
   * Habit** (a calendar for one item, PD-726). This slice ships By Habit and the view switcher; By
   * Day is a placeholder until PD-725. The active view is seeded from the deep link
   * (`?view=habit&item=<id>`, read by `HabitTracker.svelte`) and otherwise defaults to By Day.
   */
  interface Props {
    items: HabitItemView[];
    schedules: HabitSchedule[];
    settings: HabitSettings;
    today: string;
    pending: PendingHabitWrite[];
    initialView?: 'day' | 'habit';
    initialItemId?: number | null;
    onToggle: (itemId: number, day: string, done: boolean) => void;
  }

  let {
    items,
    schedules,
    settings,
    today,
    pending,
    initialView = 'day',
    initialItemId = null,
    onToggle,
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
    <p class="placeholder">By Day arrives in PD-725.</p>
  {/if}
</div>

<style lang="scss" src="./LogView.scss"></style>
