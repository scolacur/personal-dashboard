<script lang="ts">
  import type { DrugLogDrug, HabitSettings } from '@dashboard/shared';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import ByDayList from './ByDayList.svelte';
  import ByDrugCalendar from './ByDrugCalendar.svelte';

  /** The Log tab (PD-975, Drug log widget): By Day | By Drug, like the Habit Tracker's Log. */
  interface Props {
    drugs: DrugLogDrug[];
    settings: HabitSettings;
    today: string;
    onChanged: () => void;
  }

  let { drugs, settings, today, onChanged }: Props = $props();

  type View = 'day' | 'drug';
  const VIEWS: { value: View; label: string }[] = [
    { value: 'day', label: 'By Day' },
    { value: 'drug', label: 'By Drug' },
  ];
  let view = $state<View>('day');
</script>

<div class="log-view">
  <SegmentedToggle label="Log view" options={VIEWS} value={view} onChange={(v) => (view = v)} />
  {#if view === 'drug'}
    <ByDrugCalendar {drugs} {settings} {today} {onChanged} />
  {:else}
    <ByDayList {drugs} {settings} {today} {onChanged} />
  {/if}
</div>

<style lang="scss" src="./LogView.scss"></style>
