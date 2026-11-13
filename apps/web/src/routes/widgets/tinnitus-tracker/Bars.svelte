<script lang="ts">
  import { TINNITUS_MAX } from '@dashboard/shared';
  import { fmtAvg, MIN_N, type Group } from './stats';

  /**
   * Horizontal average-intensity bars on a fixed 0–10 scale (PD-706), so bars in different views
   * compare by eye.
   *
   * With `compare`, each row also carries a tick at the comparison average (tagged vs. untagged
   * readings). The two are told apart by **shape**, a bar and a tick, not by colour, and both values
   * are printed. A row with fewer than MIN_N readings on either side is dimmed and says so.
   */
  export interface BarRow {
    key: string;
    label: string;
    sub?: string;
    value: Group;
    compare?: Group;
  }

  interface Props {
    rows: BarRow[];
    /** Legend text for the bar and the tick. Only shown when rows carry `compare`. */
    legend?: { value: string; compare: string };
  }

  let { rows, legend }: Props = $props();

  const readings = (n: number) => `${n} reading${n === 1 ? '' : 's'}`;
  const pct = (v: number | null) => ((v ?? 0) / TINNITUS_MAX) * 100;
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
    <li class="row" class:thin={thin(r)}>
      <div class="name">
        {r.label}
        {#if r.sub}<span class="sub">{r.sub}</span>{/if}
      </div>
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
          <span class="muted">no readings</span>
        {:else}
          <strong>{fmtAvg(r.value.avg)}</strong>
          <span class="muted">{readings(r.value.n)}</span>
          {#if r.compare}
            <span class="muted">
              · without {r.compare.avg === null ? '–' : fmtAvg(r.compare.avg)} · {readings(r.compare.n)}
            </span>
          {/if}
          {#if thin(r)}<em class="few">too few to tell</em>{/if}
        {/if}
      </div>
    </li>
  {/each}
</ul>

<style lang="scss" src="./Bars.scss"></style>
