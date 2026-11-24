<script lang="ts">
  import {
    addSleepDays,
    sleepRestedColor,
    sleepRestedLabel,
    SLEEP_RESTED_COLORS,
    SLEEP_RUBRIC,
    type SleepEntry,
  } from '@dashboard/shared';
  import { durationMs } from './stats';
  import { formatClock, formatDuration, formatWakeDate } from './time';

  /**
   * Nightly duration: one bar per night, coloured by rested score, with a dashed line at the
   * average. Hand-drawn SVG — the web app has no chart dependency. Tapping a bar shows its details
   * below; every value is also in the History list, so the detail is never the only way to read one.
   */
  interface Props {
    entries: SleepEntry[];
    /** First wake date on the axis. Null: from the first night. */
    since: string | null;
    today: string;
  }

  let { entries, since, today }: Props = $props();

  const HEIGHT = 200;
  const PAD = { top: 10, right: 8, bottom: 24, left: 28 };
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  let width = $state(320);
  let selected = $state<SleepEntry | null>(null);

  const from = $derived(since ?? entries.reduce((min, e) => (e.wakeDate < min ? e.wakeDate : min), today));
  const dayIndex = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
  const slots = $derived(dayIndex(today) + 1);

  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 10));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slotW = $derived(plotW / slots);
  const barW = $derived(Math.max(1, Math.min(slotW * 0.75, 24)));

  const maxHours = $derived(Math.max(10, Math.ceil(Math.max(0, ...entries.map((e) => durationMs(e) / HOUR)))));
  const yTicks = $derived(Array.from({ length: Math.floor(maxHours / 2) + 1 }, (_, i) => i * 2));
  const sy = (hours: number) => PAD.top + plotH - (hours / maxHours) * plotH;
  const sx = (date: string) => PAD.left + (dayIndex(date) + 0.5) * slotW;

  const avgHours = $derived(entries.length ? entries.reduce((a, e) => a + durationMs(e), 0) / entries.length / HOUR : null);

  /** About one date label per 70px. */
  const xTicks = $derived.by(() => {
    const step = Math.max(1, Math.ceil(slots / Math.max(2, Math.floor(plotW / 70))));
    const out: string[] = [];
    for (let i = 0; i < slots; i += step) out.push(addSleepDays(from, i));
    return out;
  });

  const tickLabel = (date: string) => formatWakeDate(date).replace(/^\S+\s/, '');

  function toggle(e: SleepEntry) {
    selected = selected?.id === e.id ? null : e;
  }
</script>

<div class="chart" bind:clientWidth={width}>
  <svg {width} height={HEIGHT} role="img" aria-label="Nightly sleep duration, {entries.length} nights, coloured by rested score">
    {#each yTicks as t (t)}
      <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
      <text class="tick y" x={PAD.left - 6} y={sy(t)} dy="0.32em">{t}h</text>
    {/each}
    {#each xTicks as t (t)}
      <text class="tick x" x={sx(t)} y={HEIGHT - 6}>{tickLabel(t)}</text>
    {/each}

    {#each entries as e (e.id)}
      {@const h = durationMs(e) / HOUR}
      <rect
        class="bar"
        class:active={selected?.id === e.id}
        x={sx(e.wakeDate) - barW / 2}
        y={sy(h)}
        width={barW}
        height={Math.max(0, sy(0) - sy(h))}
        rx={Math.min(3, barW / 2)}
        fill={sleepRestedColor(e.rested)}
        role="button"
        tabindex="0"
        aria-label="{formatWakeDate(e.wakeDate)}: {formatDuration(durationMs(e))}, rested {e.rested}"
        onclick={() => toggle(e)}
        onkeydown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle(e);
          } else if (ev.key === 'Escape') selected = null;
        }}
      />
    {/each}

    {#if avgHours !== null}
      <line class="avg" x1={PAD.left} x2={width - PAD.right} y1={sy(avgHours)} y2={sy(avgHours)} />
    {/if}
  </svg>

  <div class="legend" aria-hidden="true">
    {#each Object.entries(SLEEP_RESTED_COLORS) as [score, color] (score)}
      <span><i class="key" style:background={color}></i>{SLEEP_RUBRIC[Number(score)]}</span>
    {/each}
    <span><i class="key-line"></i>Average</span>
  </div>

  {#if selected}
    <p class="detail" role="status">
      <strong>{formatWakeDate(selected.wakeDate)}</strong>
      · {formatClock(selected.sleepAt)} → {formatClock(selected.wakeAt)} · {formatDuration(durationMs(selected))} · {selected.rested}
      {sleepRestedLabel(selected.rested)}
    </p>
  {/if}
</div>

<style lang="scss" src="./DurationChart.scss"></style>
