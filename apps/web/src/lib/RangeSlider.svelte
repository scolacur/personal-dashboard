<script lang="ts">
  /**
   * A large whole-number slider, vertical (drag up to raise) or horizontal (drag right to raise).
   *
   * Lifted from the Tinnitus Tracker's IntensitySlider so the Sleep Journal's rested slider can share
   * it (PD-51, Sleep Journal widget). Hand-built, not a native `<input type="range">`: vertical range
   * inputs are still inconsistent across mobile browsers, and the native thumb is far too small to
   * hit with a thumb. Pointer capture lets a drag carry on past the track's edges.
   *
   * The fill colour defaults to a shift from the accent toward red as the value rises; pass `color`
   * to paint it yourself (the Sleep Journal colours it by rested score).
   */
  interface Props {
    value: number;
    min: number;
    max: number;
    /** Accessible name. */
    label: string;
    orientation?: 'vertical' | 'horizontal';
    compact?: boolean;
    /** Fill colour. Omit for the default accent→red ramp. */
    color?: string;
  }

  let { value = $bindable(), min, max, label, orientation = 'vertical', compact = false, color }: Props = $props();

  let track = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const horizontal = $derived(orientation === 'horizontal');
  const span = $derived(max - min);
  const pct = $derived(((value - min) / span) * 100);
  const ticks = $derived(Array.from({ length: span + 1 }, (_, i) => min + i));

  function set(next: number) {
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    if (clamped !== value) {
      value = clamped;
      // A small tick on each step where the phone supports it (Android; iOS Safari ignores it).
      try {
        navigator.vibrate?.(5);
      } catch {
        // ignore
      }
    }
  }

  function valueAt(e: PointerEvent): number {
    if (!track) return value;
    const r = track.getBoundingClientRect();
    const frac = horizontal ? (e.clientX - r.left) / r.width : 1 - (e.clientY - r.top) / r.height;
    return min + frac * span;
  }

  function onPointerDown(e: PointerEvent) {
    track?.setPointerCapture(e.pointerId);
    dragging = true;
    set(valueAt(e));
  }

  function onPointerMove(e: PointerEvent) {
    if (dragging) set(valueAt(e));
  }

  function onPointerUp() {
    dragging = false;
  }

  function onKeydown(e: KeyboardEvent) {
    const step: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 };
    if (e.key in step) set(value + step[e.key]);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else return;
    e.preventDefault();
  }
</script>

<div
  class="slider"
  class:compact
  class:dragging
  class:horizontal
  class:painted={color !== undefined}
  bind:this={track}
  role="slider"
  tabindex="0"
  aria-label={label}
  aria-orientation={orientation}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  style:--pct={pct}
  style:--level-color={color}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onkeydown={onKeydown}
>
  <div class="fill"></div>
  <ol class="ticks" aria-hidden="true">
    {#each ticks as t (t)}
      <li class:active={t <= value}></li>
    {/each}
  </ol>
  <div class="thumb"></div>
</div>

<style lang="scss" src="./RangeSlider.scss"></style>
