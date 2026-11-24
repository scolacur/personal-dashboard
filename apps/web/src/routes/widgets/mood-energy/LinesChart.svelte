<script lang="ts">
  import {
    energyColor,
    energyLabel,
    moodLabel,
    scale15Color,
    MOOD_ENERGY_MAX,
    MOOD_ENERGY_MIN,
  } from '@dashboard/shared';
  import { dailySeries, daysBetween, type DayPoint } from './stats';
  import { formatDay } from './days';
  import type { MoodEnergyEntry } from '@dashboard/shared';

  /**
   * Daily mood and energy over time: two lines on one 1–5 scale. Mood is solid with dots in the
   * red→green scale; energy is dashed in its blue ramp — told apart by line style as well as colour.
   * Hand-drawn SVG: the web app has no chart dependency.
   *
   * Tapping a day shows its values. Every value is also in the Log tab's list.
   */
  interface Props {
    entries: MoodEnergyEntry[];
    /** First day of the range, or null for "from the first entry". */
    since: string | null;
    today: string;
  }

  let { entries, since, today }: Props = $props();

  const HEIGHT = 200;
  const PAD = { top: 10, right: 12, bottom: 26, left: 22 };
  const Y_TICKS = [1, 2, 3, 4, 5];

  let width = $state(320);
  let selected = $state<DayPoint | null>(null);

  const points = $derived(dailySeries(entries));
  const first = $derived(since ?? points[0]?.day ?? today);
  // One slot per day, the point in its middle.
  const slots = $derived(Math.max(daysBetween(first, today) + 1, 1));
  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 10));
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const sx = (day: string) => PAD.left + ((daysBetween(first, day) + 0.5) / slots) * plotW;
  const sy = (v: number) => PAD.top + plotH - ((v - MOOD_ENERGY_MIN) / (MOOD_ENERGY_MAX - MOOD_ENERGY_MIN)) * plotH;

  const path = (key: 'mood' | 'energy') =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.day).toFixed(1)},${sy(p[key]).toFixed(1)}`).join('');

  /** About one date label per 70px. */
  const xTicks = $derived.by(() => {
    const maxTicks = Math.max(2, Math.floor(plotW / 70));
    const step = Math.max(1, Math.ceil(slots / maxTicks));
    const ticks: string[] = [];
    for (let i = 0; i < slots; i += step) {
      const d = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000);
      ticks.push(d.toISOString().slice(0, 10));
    }
    return ticks;
  });

  const tickLabel = (day: string) => formatDay(day).split(' ').slice(1).join(' ');

  function toggle(p: DayPoint) {
    selected = selected?.day === p.day ? null : p;
  }

  const popup = $derived.by(() => {
    if (!selected) return null;
    const cy = Math.min(sy(selected.mood), sy(selected.energy));
    return { left: Math.min(Math.max(sx(selected.day), 90), width - 90), top: cy, below: cy < 80 };
  });
</script>

<div class="chart" bind:clientWidth={width}>
  <svg {width} height={HEIGHT} role="img" aria-label="Mood and energy over time: {points.length} days">
    {#each Y_TICKS as t (t)}
      <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
      <text class="tick y" x={PAD.left - 6} y={sy(t)} dy="0.32em">{t}</text>
    {/each}
    {#each xTicks as t (t)}
      <text class="tick x" x={sx(t)} y={HEIGHT - 8}>{tickLabel(t)}</text>
    {/each}

    {#if points.length > 1}
      <path class="line energy" d={path('energy')} style:stroke={energyColor(4)} />
      <path class="line mood" d={path('mood')} />
    {/if}

    {#each points as p (p.day)}
      <circle class="dot" cx={sx(p.day)} cy={sy(p.energy)} r="3" style:fill={energyColor(p.energy)} />
      <circle class="dot" class:active={selected?.day === p.day} cx={sx(p.day)} cy={sy(p.mood)} r="4" style:fill={scale15Color(p.mood)} />
    {/each}
    <!-- Hit targets: a full-height column per day, so a thumb finds it. -->
    {#each points as p (p.day)}
      <rect
        class="hit"
        x={sx(p.day) - Math.max(plotW / slots, 12) / 2}
        y={PAD.top}
        width={Math.max(plotW / slots, 12)}
        height={plotH}
        role="button"
        tabindex="0"
        aria-label="{formatDay(p.day)}: mood {p.mood}, energy {p.energy}"
        onclick={() => toggle(p)}
        onkeydown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle(p);
          } else if (ev.key === 'Escape') selected = null;
        }}
      />
    {/each}
  </svg>

  {#if selected && popup}
    <div class="popup" class:below={popup.below} style:left="{popup.left}px" style:top="{popup.top}px" role="status">
      <div class="pw">{formatDay(selected.day, { year: true })}</div>
      <div>Mood <strong>{selected.mood}</strong> {moodLabel(selected.mood)}</div>
      <div>Energy <strong>{selected.energy}</strong> {energyLabel(selected.energy)}</div>
    </div>
  {/if}

  <div class="legend" aria-hidden="true">
    <span><i class="key-mood"></i>Mood</span>
    <span><i class="key-energy" style:border-color={energyColor(4)}></i>Energy</span>
  </div>
</div>

<style lang="scss" src="./LinesChart.scss"></style>
