<script lang="ts">
  import { TINNITUS_MAX, TINNITUS_MIN } from '@dashboard/shared';

  /**
   * A large vertical 0–10 slider. Drag (or tap) up to raise it.
   *
   * Hand-built, not a native `<input type="range">`: vertical range inputs are still inconsistent
   * across mobile browsers, and the native thumb is far too small to hit with a thumb. Pointer
   * capture lets a drag carry on past the track's edges.
   */
  interface Props {
    value: number;
    compact?: boolean;
  }

  let { value = $bindable(), compact = false }: Props = $props();

  let track = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  const span = TINNITUS_MAX - TINNITUS_MIN;
  const pct = $derived(((value - TINNITUS_MIN) / span) * 100);
  const ticks = Array.from({ length: span + 1 }, (_, i) => TINNITUS_MIN + i);

  function set(next: number) {
    const clamped = Math.min(TINNITUS_MAX, Math.max(TINNITUS_MIN, Math.round(next)));
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

  function valueAt(clientY: number): number {
    if (!track) return value;
    const r = track.getBoundingClientRect();
    const frac = 1 - (clientY - r.top) / r.height;
    return TINNITUS_MIN + frac * span;
  }

  function onPointerDown(e: PointerEvent) {
    track?.setPointerCapture(e.pointerId);
    dragging = true;
    set(valueAt(e.clientY));
  }

  function onPointerMove(e: PointerEvent) {
    if (dragging) set(valueAt(e.clientY));
  }

  function onPointerUp() {
    dragging = false;
  }

  function onKeydown(e: KeyboardEvent) {
    const step: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 2, PageDown: -2 };
    if (e.key in step) set(value + step[e.key]);
    else if (e.key === 'Home') set(TINNITUS_MIN);
    else if (e.key === 'End') set(TINNITUS_MAX);
    else return;
    e.preventDefault();
  }
</script>

<div
  class="slider"
  class:compact
  class:dragging
  bind:this={track}
  role="slider"
  tabindex="0"
  aria-label="Tinnitus intensity"
  aria-orientation="vertical"
  aria-valuemin={TINNITUS_MIN}
  aria-valuemax={TINNITUS_MAX}
  aria-valuenow={value}
  style:--pct={pct}
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

<style lang="scss" src="./IntensitySlider.scss"></style>
