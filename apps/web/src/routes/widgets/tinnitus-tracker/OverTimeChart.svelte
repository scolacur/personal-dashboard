<script lang="ts">
  import { TINNITUS_MAX, tinnitusLabel, type TinnitusEntry } from '@dashboard/shared';
  import { dailyAverages, fmtAvg, startOfDay } from './stats';
  import { formatWhen } from './time';

  /**
   * Intensity over time (PD-706): every reading as a dot, plus a line through each day's average.
   * Hand-drawn SVG. The web app has no chart dependency, and adding one is a sensitive-path change
   * (`package.json`) for what is two marks and an axis.
   *
   * Tapping a dot opens its details. Every value is also in the Log tab, so the popup is never the
   * only way to read one.
   */
  interface Props {
    entries: TinnitusEntry[];
    /** Unix ms. 0 means "from the first entry". */
    from: number;
    now?: number;
  }

  let { entries, from, now = Date.now() }: Props = $props();

  const HEIGHT = 220;
  const PAD = { top: 10, right: 12, bottom: 26, left: 26 };
  const DAY = 24 * 60 * 60 * 1000;
  const Y_TICKS = [0, 2, 4, 6, 8, 10];

  let width = $state(320);
  let selected = $state<TinnitusEntry | null>(null);

  const x0 = $derived(from > 0 ? from : startOfDay(Math.min(...entries.map((e) => e.recordedAt), now)));
  const x1 = $derived(startOfDay(now) + DAY);
  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 10));
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const sx = (ms: number) => PAD.left + ((ms - x0) / (x1 - x0)) * plotW;
  const sy = (v: number) => PAD.top + plotH - (v / TINNITUS_MAX) * plotH;

  const days = $derived(dailyAverages(entries));
  const avgPath = $derived(
    days.map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.day + DAY / 2).toFixed(1)},${sy(d.avg ?? 0).toFixed(1)}`).join(''),
  );

  /** Day ticks, spaced so labels never crowd: about one per 70px. */
  const xTicks = $derived.by(() => {
    const spanDays = Math.round((x1 - x0) / DAY);
    const maxTicks = Math.max(2, Math.floor(plotW / 70));
    const step = Math.max(1, Math.ceil(spanDays / maxTicks));
    const ticks: number[] = [];
    for (let t = x0; t < x1; t += step * DAY) ticks.push(startOfDay(t + DAY / 2));
    return ticks;
  });

  const tickLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function toggle(e: TinnitusEntry) {
    selected = selected?.id === e.id ? null : e;
  }

  // The popup sits above the dot, flipped below when the dot is near the top, and clamped inside.
  const popup = $derived.by(() => {
    if (!selected) return null;
    const cx = sx(selected.recordedAt);
    const cy = sy(selected.intensity);
    return { left: Math.min(Math.max(cx, 90), width - 90), top: cy, below: cy < 90 };
  });
</script>

<div class="chart" bind:clientWidth={width}>
  <svg
    width={width}
    height={HEIGHT}
    role="img"
    aria-label="Tinnitus intensity over time: {entries.length} readings across {days.length} days"
  >
    {#each Y_TICKS as t (t)}
      <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
      <text class="tick y" x={PAD.left - 6} y={sy(t)} dy="0.32em">{t}</text>
    {/each}
    {#each xTicks as t (t)}
      <text class="tick x" x={sx(t + DAY / 2)} y={HEIGHT - 8}>{tickLabel(t)}</text>
    {/each}

    {#if days.length > 1}
      <path class="avg" d={avgPath} />
    {/if}

    {#each entries as e (e.id)}
      <circle class="dot" class:active={selected?.id === e.id} cx={sx(e.recordedAt)} cy={sy(e.intensity)} r="4" />
    {/each}
    <!-- Hit targets drawn last and bigger than the dots (24px), so a thumb finds them. -->
    {#each entries as e (e.id)}
      <circle
        class="hit"
        cx={sx(e.recordedAt)}
        cy={sy(e.intensity)}
        r="12"
        role="button"
        tabindex="0"
        aria-label="{formatWhen(e.recordedAt)}: {e.intensity}"
        onclick={() => toggle(e)}
        onkeydown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle(e);
          } else if (ev.key === 'Escape') selected = null;
        }}
      />
    {/each}
  </svg>

  {#if selected && popup}
    <div class="popup" class:below={popup.below} style:left="{popup.left}px" style:top="{popup.top}px" role="status">
      <div class="pv">
        <strong>{selected.intensity}</strong>
        {#if tinnitusLabel(selected.intensity)}<span>{tinnitusLabel(selected.intensity)}</span>{/if}
      </div>
      <div class="pw">{formatWhen(selected.recordedAt)}</div>
      {#if selected.tags.length}<div class="pt">{selected.tags.join(' · ')}</div>{/if}
      {#if selected.notes}<div class="pn">{selected.notes}</div>{/if}
    </div>
  {/if}

  <div class="legend" aria-hidden="true">
    <span><i class="key-dot"></i>Reading</span>
    <span><i class="key-line"></i>Daily average</span>
  </div>
  {#if days.length > 0}
    <p class="summary">
      Average {fmtAvg(entries.reduce((a, e) => a + e.intensity, 0) / entries.length)} over {entries.length} readings
    </p>
  {/if}
</div>

<style lang="scss" src="./OverTimeChart.scss"></style>
