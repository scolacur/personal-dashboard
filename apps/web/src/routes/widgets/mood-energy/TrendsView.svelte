<script lang="ts">
  import { energyColor, scale15Color, type MoodEnergyEntry } from '@dashboard/shared';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import { byTag, byWeekday, fmtAvg, inRange, MIN_N, RANGES, rangeSince, summary, type RangeId } from './stats';
  import LinesChart from './LinesChart.svelte';
  import Bars from './Bars.svelte';

  /**
   * The Trends tab. One range control above everything, and every view uses that same slice. The
   * page already holds every day (one small row each), so this filters locally rather than refetching
   * — which also means unsynced saves show up here at once.
   */
  interface Props {
    entries: MoodEnergyEntry[];
    today: string;
  }

  let { entries, today }: Props = $props();

  const RANGE_KEY = 'mood-energy:range';

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

  const since = $derived(rangeSince(range, today));
  const slice = $derived(inRange(entries, since, today));
  const totals = $derived(summary(slice));
  const tagRows = $derived(byTag(slice).map((t) => ({ key: t.tag, label: t.tag, value: t.with, compare: t.without })));
  const weekdayRows = $derived(byWeekday(slice).map((g) => ({ key: g.label, label: g.label, value: g })));
  const anyThin = $derived(
    [...tagRows.flatMap((r) => [r.value, r.compare]), ...weekdayRows.map((r) => r.value)].some((g) => g.n > 0 && g.n < MIN_N),
  );

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

  {#if slice.length === 0}
    <p class="empty">No days logged in this range yet.</p>
  {:else}
    <section>
      <h3>Averages</h3>
      <dl class="summary">
        <div>
          <dt>Mood</dt>
          <dd style:--swatch={scale15Color(Math.round(totals.mood ?? 3))}>{fmtAvg(totals.mood ?? 0)}</dd>
        </div>
        <div>
          <dt>Energy</dt>
          <dd style:--swatch={energyColor(Math.round(totals.energy ?? 3))}>{fmtAvg(totals.energy ?? 0)}</dd>
        </div>
        <div>
          <dt>Days logged</dt>
          <dd>{totals.n}</dd>
        </div>
      </dl>
    </section>

    <section>
      <h3>Over time</h3>
      <LinesChart entries={slice} {since} {today} />
    </section>

    <section>
      <h3>Mood by feeling</h3>
      <p class="hint">Average mood on days with each feeling, against days without it.</p>
      {#if tagRows.length}
        <Bars rows={tagRows} legend={{ value: 'With feeling', compare: 'Without' }} />
      {:else}
        <p class="empty">No feelings tagged in this range.</p>
      {/if}
    </section>

    <section>
      <h3>Mood by weekday</h3>
      <Bars rows={weekdayRows} />
    </section>

    {#if anyThin}
      <p class="footnote">Groups with fewer than {MIN_N} days are faded. There's too little data to tell yet.</p>
    {/if}
  {/if}
</div>

<style lang="scss" src="./TrendsView.scss"></style>
