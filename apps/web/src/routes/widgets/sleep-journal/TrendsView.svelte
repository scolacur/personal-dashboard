<script lang="ts">
  import { SLEEP_RESTED_MAX, type SleepEntry } from '@dashboard/shared';
  import SegmentedToggle from '$lib/SegmentedToggle.svelte';
  import { fetchEntriesSince } from './api';
  import { byTag, fmtAvg, MIN_N, RANGES, rangeSince, summarize, type Group, type RangeId } from './stats';
  import { formatDuration, todayWakeDate, toTimeInput } from './time';
  import DurationChart from './DurationChart.svelte';

  /**
   * The Trends tab. One range control above everything; every view below uses that same slice, so
   * the numbers always agree. All arithmetic is in `stats.ts`.
   */
  const RANGE_KEY = 'sleep-journal:range';
  const today = todayWakeDate();

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
  let entries = $state<SleepEntry[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state('');

  const since = $derived(rangeSince(range, today));
  const summary = $derived(summarize(entries));
  const tags = $derived(byTag(entries));
  const nights = (n: number) => `${n} night${n === 1 ? '' : 's'}`;
  const thin = (a: Group, b: Group) => a.n < MIN_N || b.n < MIN_N;
  const pct = (v: number | null) => ((v ?? 0) / SLEEP_RESTED_MAX) * 100;

  // Refetch on range change. The previous render stays up, faded, until the new data lands.
  $effect(() => {
    const from = since ?? '0000-01-01';
    loading = true;
    error = '';
    let cancelled = false;
    fetchEntriesSince(from)
      .then((list) => {
        if (cancelled) return;
        entries = list;
        loaded = true;
      })
      .catch(() => {
        if (!cancelled) error = "Couldn't load nights. Check the connection.";
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
    <p class="empty">No nights in this range yet.</p>
  {:else if loaded}
    <div class="views" class:loading>
      <dl class="summary" aria-label="Averages">
        <div><dt>Avg sleep</dt><dd>{summary.avgDurationMs === null ? '–' : formatDuration(summary.avgDurationMs)}</dd></div>
        <div><dt>Avg rested</dt><dd>{summary.avgRested === null ? '–' : fmtAvg(summary.avgRested)}</dd></div>
        <div><dt>Avg asleep</dt><dd>{summary.avgSleepMinutes === null ? '–' : toTimeInput(summary.avgSleepMinutes)}</dd></div>
        <div><dt>Avg awake</dt><dd>{summary.avgWakeMinutes === null ? '–' : toTimeInput(summary.avgWakeMinutes)}</dd></div>
        <div><dt>Nights</dt><dd>{summary.n}</dd></div>
      </dl>

      <section>
        <h3>Sleep per night</h3>
        <DurationChart {entries} {since} {today} />
      </section>

      <section>
        <h3>By tag</h3>
        <p class="hint">Average rested on nights with each tag, against nights without it.</p>
        {#if tags.length}
          <div class="legend" aria-hidden="true">
            <span><i class="key-bar"></i>With tag</span>
            <span><i class="key-tick"></i>Without tag</span>
          </div>
          <ul class="rows">
            {#each tags as t (t.tag)}
              <li class="row" class:thin={thin(t.with, t.without)}>
                <div class="name">{t.tag} <span class="sub">avg ×{fmtAvg(t.avgCount)}</span></div>
                <div class="track" aria-hidden="true">
                  <div class="bar" style:width="{pct(t.with.avg)}%"></div>
                  {#if t.without.avg !== null}<div class="tick" style:left="{pct(t.without.avg)}%"></div>{/if}
                </div>
                <div class="figures">
                  <strong>{t.with.avg === null ? '–' : fmtAvg(t.with.avg)}</strong>
                  <span class="muted">{nights(t.with.n)}</span>
                  <span class="muted">
                    · without {t.without.avg === null ? '–' : fmtAvg(t.without.avg)} · {nights(t.without.n)}
                  </span>
                  {#if thin(t.with, t.without)}<em class="few">too few to tell</em>{/if}
                </div>
              </li>
            {/each}
          </ul>
          {#if tags.some((t) => thin(t.with, t.without))}
            <p class="footnote">Tags with fewer than {MIN_N} nights on either side are faded. There's too little data to tell yet.</p>
          {/if}
        {:else}
          <p class="empty">No tagged nights in this range.</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style lang="scss" src="./TrendsView.scss"></style>
