<script lang="ts">
  import { MOOD_ENERGY_MAX } from '@dashboard/shared';
  import { fmtAvg, MIN_N, type Group } from './stats';

  /**
   * Horizontal average-mood bars on a fixed 0–5 scale, so bars in different views compare by eye.
   * Adapted from the Tinnitus Tracker's Bars (no cross-widget imports).
   *
   * With `compare`, each row also carries a tick at the comparison average (days with a tag vs.
   * days without). Bar and tick differ by shape, not colour, and both values are printed. A row with
   * fewer than MIN_N days on either side is dimmed and says so.
   */
  export interface BarRow {
    key: string;
    label: string;
    value: Group;
    compare?: Group;
  }

  interface Props {
    rows: BarRow[];
    /** Legend text for the bar and the tick. Only shown when rows carry `compare`. */
    legend?: { value: string; compare: string };
  }

  let { rows, legend }: Props = $props();

  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const pct = (v: number | null) => ((v ?? 0) / MOOD_ENERGY_MAX) * 100;
  const thin = (r: BarRow) => r.value.n < MIN_N || (r.compare !== undefined && r.compare.n < MIN_N);
</script>

{#if legend}
  <div class="legend" aria-hidden="true">
    <span><i class="key-bar"></i>{legend.value}</span>
    <span><i class="key-tick"></i>{legend.compare}</span>
  </div>
{/if}

<ul class="rows">
  {#each rows as r (r.key)}
    <li class="row" class:thin={r.value.n > 0 && thin(r)}>
      <div class="name">{r.label}</div>
      <div class="track" aria-hidden="true">
        {#if r.value.avg !== null}
          <div class="bar" style:width="{pct(r.value.avg)}%"></div>
        {/if}
        {#if r.compare?.avg != null}
          <div class="tick" style:left="{pct(r.compare.avg)}%"></div>
        {/if}
      </div>
      <div class="figures">
        {#if r.value.avg === null}
          <span class="muted">no days</span>
        {:else}
          <strong>{fmtAvg(r.value.avg)}</strong>
          <span class="muted">{days(r.value.n)}</span>
          {#if r.compare}
            <span class="muted">· without {r.compare.avg === null ? '–' : fmtAvg(r.compare.avg)} · {days(r.compare.n)}</span>
          {/if}
          {#if thin(r)}<em class="few">too few to tell</em>{/if}
        {/if}
      </div>
    </li>
  {/each}
</ul>

<style lang="scss" src="./Bars.scss"></style>
