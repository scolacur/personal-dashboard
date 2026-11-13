<script lang="ts">
  import type { TinnitusEntry } from '@dashboard/shared';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import { fetchEntriesSince } from './api';
  import { byDaypart, byTag, MIN_N, RANGES, rangeStart, type RangeId } from './stats';
  import OverTimeChart from './OverTimeChart.svelte';
  import Bars from './Bars.svelte';

  /**
   * The Trends tab (PD-706). One range control above everything, and every view below it uses that
   * same slice, so the numbers always agree.
   */
  const RANGE_KEY = 'tinnitus-tracker:range';

  function initialRange(): RangeId {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      if (RANGES.some((r) => r.value === v)) return v as RangeId;
    } catch {
      // per-viewer convenience only
    }
    return '30d';
  }

  let range = $state<RangeId>(initialRange());
  let entries = $state<TinnitusEntry[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state('');

  const from = $derived(rangeStart(range));
  const tagRows = $derived(
    byTag(entries).map((t) => ({ key: t.tag, label: t.tag, value: t.with, compare: t.without })),
  );
  const daypartRows = $derived(byDaypart(entries).map((g) => ({ key: g.id, label: g.label, sub: g.hours, value: g })));
  const anyThin = $derived(
    [...tagRows.flatMap((r) => [r.value, r.compare]), ...daypartRows.map((r) => r.value)].some(
      (g) => g.n > 0 && g.n < MIN_N,
    ),
  );

  // Refetch on range change. The previous render stays up, faded, until the new data lands.
  $effect(() => {
    const since = from;
    loading = true;
    error = '';
    let cancelled = false;
    fetchEntriesSince(since)
      .then((list) => {
        if (cancelled) return;
        entries = list;
        loaded = true;
      })
      .catch(() => {
        if (!cancelled) error = "Couldn't load readings. Check the connection.";
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function setRange(r: RangeId) {
    range = r;
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // ignore
    }
  }
</script>

<div class="trends">
  <div class="filters">
    <SegmentedToggle label="Time range" options={RANGES} value={range} onChange={setRange} />
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if loaded && entries.length === 0}
    <p class="empty">No readings in this range yet.</p>
  {:else if loaded}
    <div class="views" class:loading>
      <section>
        <h3>Intensity over time</h3>
        <OverTimeChart {entries} {from} />
      </section>

      <section>
        <h3>By tag</h3>
        <p class="hint">Average intensity of readings with each tag, against readings without it.</p>
        {#if tagRows.length}
          <Bars rows={tagRows} legend={{ value: 'With tag', compare: 'Without tag' }} />
        {:else}
          <p class="empty">No tagged readings in this range.</p>
        {/if}
      </section>

      <section>
        <h3>By time of day</h3>
        <Bars rows={daypartRows} />
      </section>

      {#if anyThin}
        <p class="footnote">Groups with fewer than {MIN_N} readings are faded. There's too little data to tell yet.</p>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss" src="./TrendsView.scss"></style>
