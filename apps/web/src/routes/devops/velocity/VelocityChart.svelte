<script lang="ts" module>
  /** Series colour roles → classes in VelocityChart.scss, all backed by design tokens. Robot and
   *  steve are the two categorical identities; the rest are neutral or reserved status colours
   *  (used only where the series IS a state: succeeded / failed / parked). */
  export type SeriesTone =
    | 'robot'
    | 'steve'
    | 'neutral'
    | 'text'
    | 'accent'
    | 'done'
    | 'stuck'
    | 'warn'
    | 'park'
    | 'gain'
    | 'loss';

  export interface ChartSeries {
    key: string;
    label: string;
    /** One value per week; null = no data that week (a line breaks there). */
    values: (number | null)[];
    tone: SeriesTone;
    /** Dashed stroke — secondary encoding so identity never rests on colour alone. */
    dashed?: boolean;
  }
</script>

<script lang="ts">
  import { niceRange, niceScale, spreadLabels, tickIndices, weekLabel } from './velocity-view';

  /**
   * Weekly chart for the Velocity page (Epic PD-895): lines or stacked bars over week buckets.
   * Hand-drawn SVG modelled on the Tinnitus OverTimeChart — the web app has no chart dependency
   * and adding one is a sensitive-path change. Hover (or focus + arrow keys) shows a crosshair and
   * a tooltip with every series' value that week; a table view carries the same numbers.
   */
  interface Props {
    weeks: number[];
    series: ChartSeries[];
    /** `diverging` (PD-923): one signed series as bars from a zero baseline, coloured by sign. */
    kind?: 'line' | 'stacked' | 'diverging';
    /** Diverging only: legend labels for the positive and negative sides. */
    signLabels?: [string, string];
    /** Accessible name, e.g. "Tickets completed per week". */
    label: string;
    format?: (v: number) => string;
    /** Fixed axis ceiling (e.g. 1 for a rate); otherwise derived from the data. */
    yMax?: number;
    height?: number;
    /** PD-916: shade from this week start to the end as "still accumulating" — data that will
     *  keep growing as bugs are found. Null/omitted = no shading. */
    shadeFrom?: number | null;
  }

  let {
    weeks,
    series,
    kind = 'line',
    label,
    format = (v: number) => String(Math.round(v * 10) / 10),
    yMax,
    height = 220,
    shadeFrom = null,
    signLabels = ['Above zero', 'Below zero'],
  }: Props = $props();

  const PAD = { top: 12, bottom: 26, left: 40 };
  let width = $state(480);
  let hover = $state<number | null>(null);

  // Lines get direct end-labels (≤ 4 series), which need room on the right.
  const directLabels = $derived(kind === 'line' && series.length > 1 && series.length <= 4);
  const padRight = $derived(directLabels ? 76 : 12);
  const plotW = $derived(Math.max(width - PAD.left - padRight, 10));
  const plotH = $derived(height - PAD.top - PAD.bottom);
  const n = $derived(weeks.length);

  const dataMax = $derived.by(() => {
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (kind === 'stacked') {
        m = Math.max(
          m,
          series.reduce((a, s) => a + (s.values[i] ?? 0), 0),
        );
      } else {
        for (const s of series) m = Math.max(m, s.values[i] ?? 0);
      }
    }
    return m;
  });
  const scale = $derived.by((): { min: number; max: number; ticks: number[] } => {
    if (kind === 'diverging') {
      const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
      return niceRange(Math.min(0, ...vals), Math.max(0, ...vals));
    }
    return { min: 0, ...(yMax !== undefined ? niceScale(yMax) : niceScale(dataMax)) };
  });

  const band = $derived(n ? plotW / n : plotW);
  const cx = (i: number) => PAD.left + band * (i + 0.5);
  const sy = (v: number) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

  /** Diverging bars: anchored at zero, 4px rounded end away from it, tone by sign. */
  const divBars = $derived.by(() => {
    if (kind !== 'diverging' || !series[0]) return [];
    const barW = Math.max(2, Math.min(band * 0.7, 28));
    const zero = sy(0);
    return series[0].values.map((v, i) => {
      if (v === null || v === 0) return null;
      const end = sy(v);
      const x = cx(i) - barW / 2;
      const h = Math.abs(zero - end);
      const r = Math.min(4, h, barW / 2);
      const up = v > 0;
      const d = up
        ? `M${x},${zero}V${end + r}Q${x},${end} ${x + r},${end}H${x + barW - r}` +
          `Q${x + barW},${end} ${x + barW},${end + r}V${zero}Z`
        : `M${x},${zero}V${end - r}Q${x},${end} ${x + r},${end}H${x + barW - r}` +
          `Q${x + barW},${end} ${x + barW},${end - r}V${zero}Z`;
      return { i, d, tone: up ? 'gain' : 'loss' };
    });
  });

  function linePath(values: (number | null)[]): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${sy(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  /** Isolated points (null on both sides) get a marker, or they'd be invisible. */
  function isolated(values: (number | null)[], i: number): boolean {
    return (
      values[i] !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null
    );
  }

  /** Stacked segments per week, bottom-up; 2px surface gap between segments, 4px rounded top. */
  const stacks = $derived.by(() => {
    if (kind !== 'stacked') return [];
    const barW = Math.max(2, Math.min(band * 0.7, 28));
    return weeks.map((_, i) => {
      let base = 0;
      const segs = series
        .map((s) => {
          const v = s.values[i] ?? 0;
          const seg = { key: s.key, tone: s.tone, y0: base, y1: base + v };
          base += v;
          return seg;
        })
        .filter((g) => g.y1 > g.y0);
      return segs.map((g, k) => {
        const top = sy(g.y1);
        const bottom = sy(g.y0) - (k > 0 ? 2 : 0);
        const h = Math.max(bottom - top, 0);
        const x = cx(i) - barW / 2;
        const r = k === segs.length - 1 ? Math.min(4, h, barW / 2) : 0;
        const d =
          `M${x},${top + h}V${top + r}` +
          (r
            ? `Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}`
            : `H${x + barW}`) +
          `V${top + h}Z`;
        return { key: g.key, tone: g.tone, d };
      });
    });
  });

  const xTicks = $derived(tickIndices(n, plotW));

  /** First week index inside the shaded region, or null when nothing in range is shaded. */
  const shadeIdx = $derived.by(() => {
    if (shadeFrom === null) return null;
    const i = weeks.findIndex((w) => w >= shadeFrom);
    return i === -1 ? null : i;
  });

  /** Last non-null value per series, for direct labels. */
  const endLabels = $derived.by(() => {
    if (!directLabels) return [];
    const raw = series.map((s) => {
      let i = n - 1;
      while (i >= 0 && s.values[i] === null) i--;
      return { s, i, y: i >= 0 ? sy(s.values[i] as number) : PAD.top };
    });
    const ys = spreadLabels(
      raw.map((r) => r.y),
      13,
      PAD.top,
      PAD.top + plotH,
    );
    return raw.filter((r) => r.i >= 0).map((r) => ({ ...r, ly: ys[raw.indexOf(r)] }));
  });

  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD.left) / band);
    hover = i >= 0 && i < n ? i : null;
  }

  function onKey(e: KeyboardEvent) {
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = hover ?? (e.key === 'ArrowRight' ? -1 : n);
      hover = Math.min(n - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    } else if (e.key === 'Escape') hover = null;
  }

  const tip = $derived.by(() => {
    if (hover === null) return null;
    const i = hover;
    const rows = series.map((s) => ({ s, v: s.values[i] }));
    const total = kind === 'stacked' ? rows.reduce((a, r) => a + (r.v ?? 0), 0) : null;
    const x = cx(i);
    return { i, rows, total, left: Math.min(Math.max(x, 80), width - 80), flip: x > width - 170 };
  });

  let showTable = $state(false);
</script>

<div class="vchart" bind:clientWidth={width}>
  {#if n === 0}
    <p class="empty">No data in this range.</p>
  {:else}
    <!-- The plot is the control: focus + arrow keys step the crosshair week by week, the keyboard
         twin of hovering. The table view is the non-interactive way to read the same numbers. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <svg
      {width}
      {height}
      role="img"
      aria-label="{label}. Use left and right arrow keys to read each week."
      tabindex="0"
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
      onkeydown={onKey}
      onblur={() => (hover = null)}
    >
      {#each scale.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={PAD.left + plotW} y1={sy(t)} y2={sy(t)} />
        <text class="tick y" x={PAD.left - 6} y={sy(t)} dy="0.32em">{format(t)}</text>
      {/each}
      {#each xTicks as i (i)}
        <text class="tick x" x={cx(i)} y={height - 8}>{weekLabel(weeks[i])}</text>
      {/each}

      {#if shadeIdx !== null}
        <rect
          class="accumulating"
          x={PAD.left + band * shadeIdx}
          y={PAD.top}
          width={band * (n - shadeIdx)}
          height={plotH}
        />
        <text class="accumulating-label" x={PAD.left + band * shadeIdx + 4} y={PAD.top + 10}
          >still accumulating</text
        >
      {/if}

      {#if hover !== null}
        <line class="crosshair" x1={cx(hover)} x2={cx(hover)} y1={PAD.top} y2={PAD.top + plotH} />
      {/if}

      {#if kind === 'diverging'}
        {#each divBars as b, i (weeks[i])}
          {#if b}
            <path class="bar tone-{b.tone}" class:dim={hover !== null && hover !== b.i} d={b.d} />
          {/if}
        {/each}
        <line class="zero" x1={PAD.left} x2={PAD.left + plotW} y1={sy(0)} y2={sy(0)} />
      {:else if kind === 'stacked'}
        {#each stacks as segs, i (weeks[i])}
          {#each segs as g (g.key)}
            <path class="bar tone-{g.tone}" class:dim={hover !== null && hover !== i} d={g.d} />
          {/each}
        {/each}
      {:else}
        {#each series as s (s.key)}
          <path class="line tone-{s.tone}" class:dashed={s.dashed} d={linePath(s.values)} />
          {#each s.values as v, i (i)}
            {#if v !== null && (hover === i || isolated(s.values, i))}
              <circle class="dot tone-{s.tone}" cx={cx(i)} cy={sy(v)} r="4" />
            {/if}
          {/each}
        {/each}
        {#each endLabels as l (l.s.key)}
          <text class="end-label" x={PAD.left + plotW + 8} y={l.ly} dy="0.32em">{l.s.label}</text>
        {/each}
      {/if}
    </svg>

    {#if tip}
      <div class="tooltip" class:flip={tip.flip} style:left="{tip.left}px" role="status">
        <div class="tt-week">Week of {weekLabel(weeks[tip.i])}</div>
        {#each tip.rows as r (r.s.key)}
          <div class="tt-row">
            <i class="swatch tone-{r.s.tone}" class:dashed={r.s.dashed}></i>
            <span>{r.s.label}</span>
            <strong>{r.v === null || r.v === undefined ? '—' : format(r.v)}</strong>
          </div>
        {/each}
        {#if tip.total !== null}
          <div class="tt-row total"><span>Total</span><strong>{format(tip.total)}</strong></div>
        {/if}
      </div>
    {/if}

    <div class="foot">
      {#if kind === 'diverging'}
        <div class="legend">
          <span><i class="swatch tone-gain"></i>{signLabels[0]}</span>
          <span><i class="swatch tone-loss"></i>{signLabels[1]}</span>
        </div>
      {:else if series.length > 1}
        <div class="legend">
          {#each series as s (s.key)}
            <span><i class="swatch tone-{s.tone}" class:dashed={s.dashed}></i>{s.label}</span>
          {/each}
        </div>
      {/if}
      <button
        type="button"
        class="table-toggle"
        onclick={() => (showTable = !showTable)}
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'Table'}
      </button>
    </div>

    {#if showTable}
      <div class="table-wrap">
        <table>
          <caption class="sr-only">{label}</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              {#each series as s (s.key)}<th scope="col">{s.label}</th>{/each}
            </tr>
          </thead>
          <tbody>
            {#each weeks as w, i (w)}
              <tr>
                <th scope="row">{weekLabel(w)}</th>
                {#each series as s (s.key)}
                  <td>{s.values[i] === null ? '—' : format(s.values[i] as number)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<style lang="scss" src="./VelocityChart.scss"></style>
