<script lang="ts">
  type Phase = 'work' | 'short-break' | 'long-break' | 'done';

  interface BarSpec {
    key: number;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    isMinutes: boolean;
    isActive: boolean;
  }

  interface Props {
    workMinutes: number;
    shortBreakMinutes: number;
    longBreakMinutes: number;
    roundsBeforeLongBreak: number;
    totalRounds: number;
    disabled?: boolean;
    activePhase?: Phase;
    onWorkChange?: () => void;
    onShortBreakChange?: () => void;
    onLongBreakChange?: () => void;
    onTotalRoundsChange?: () => void;
    onRoundsBeforeLongBreakChange?: () => void;
  }

  let {
    workMinutes = $bindable(),
    shortBreakMinutes = $bindable(),
    longBreakMinutes = $bindable(),
    roundsBeforeLongBreak = $bindable(),
    totalRounds = $bindable(),
    disabled = false,
    activePhase,
    onWorkChange,
    onShortBreakChange,
    onLongBreakChange,
    onTotalRoundsChange,
    onRoundsBeforeLongBreakChange,
  }: Props = $props();

  const specs: BarSpec[] = $derived([
    { key: 0, label: 'Work', value: workMinutes, min: 1, max: 240, step: 5, isMinutes: true, isActive: activePhase === 'work' },
    { key: 1, label: 'Short Brk', value: shortBreakMinutes, min: 1, max: 60, step: 5, isMinutes: true, isActive: activePhase === 'short-break' },
    { key: 2, label: 'Long Brk', value: longBreakMinutes, min: 1, max: 120, step: 5, isMinutes: true, isActive: activePhase === 'long-break' },
    { key: 3, label: '→ Long', value: roundsBeforeLongBreak, min: 1, max: totalRounds, step: 1, isMinutes: false, isActive: false },
    { key: 4, label: 'Total', value: totalRounds, min: 1, max: 20, step: 1, isMinutes: false, isActive: false },
  ]);

  let dragIndex = $state(-1);
  let dragRect: DOMRect | null = $state(null);

  function fillPct(spec: BarSpec): number {
    return Math.min(100, Math.max(0, ((spec.value - spec.min) / (spec.max - spec.min)) * 100));
  }

  function valLabel(spec: BarSpec): string {
    return spec.isMinutes ? `${spec.value}m` : `${spec.value}`;
  }

  function snapValue(raw: number, step: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(raw / step) * step));
  }

  function yToValue(y: number, spec: BarSpec): number {
    if (!dragRect) return spec.value;
    const fraction = 1 - (y - dragRect.top) / dragRect.height;
    return snapValue(spec.min + fraction * (spec.max - spec.min), spec.step, spec.min, spec.max);
  }

  function commit(index: number, value: number): void {
    switch (index) {
      case 0: workMinutes = value; onWorkChange?.(); break;
      case 1: shortBreakMinutes = value; onShortBreakChange?.(); break;
      case 2: longBreakMinutes = value; onLongBreakChange?.(); break;
      case 3: roundsBeforeLongBreak = value; onRoundsBeforeLongBreakChange?.(); break;
      case 4: totalRounds = value; onTotalRoundsChange?.(); break;
    }
  }

  function onPointerDown(e: PointerEvent, index: number, spec: BarSpec): void {
    if (disabled) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragIndex = index;
    dragRect = el.getBoundingClientRect();
    commit(index, yToValue(e.clientY, spec));
  }

  function onPointerMove(e: PointerEvent, index: number, spec: BarSpec): void {
    if (dragIndex !== index) return;
    commit(index, yToValue(e.clientY, spec));
  }

  function endDrag(): void {
    dragIndex = -1;
    dragRect = null;
  }
</script>

<div class="ib-bars" class:ib-bars--disabled={disabled}>
  {#each specs as spec (spec.key)}
    {@const fill = fillPct(spec)}
    <div class="ib-col">
      <div
        class="ib-track"
        class:ib-track--active={spec.isActive}
        class:ib-track--dragging={dragIndex === spec.key}
        style="--fill: {fill}%"
        role="slider"
        tabindex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-orientation="vertical"
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={spec.value}
        aria-label={spec.label}
        onpointerdown={(e) => onPointerDown(e, spec.key, spec)}
        onpointermove={(e) => onPointerMove(e, spec.key, spec)}
        onpointerup={endDrag}
        onpointercancel={endDrag}
      >
        <div class="ib-fill"></div>
        <span class="ib-val ib-val--bg">{valLabel(spec)}</span>
        <span class="ib-val ib-val--fg">{valLabel(spec)}</span>
      </div>
      <div class="ib-name">{spec.label}</div>
    </div>
  {/each}
</div>

<style lang="scss" src="./IntervalBars.scss"></style>
