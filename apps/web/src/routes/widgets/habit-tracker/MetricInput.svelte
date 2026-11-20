<script lang="ts">
  import { choiceValue, parseChoiceValue, type HabitMetricTodayRow } from '@dashboard/shared';

  /**
   * One metric's inline input on Today (PD-724): a time picker, a number field, or a multi-select of
   * choice options. Every edit is a set-state write ("metric M on day D = value / cleared"), routed
   * up through `onMetric` to the shared offline outbox — the same path a tick takes (PROJECT.md §4).
   *
   * "Not logged" and a logged value are different: an empty time / number field, or an empty choice
   * selection, sends `null` (cleared); a logged `"0"` is a real number value, not a clear. The value
   * arrives already folded with any pending write (see HabitTracker), so the control reflects the
   * optimistic state.
   */
  let {
    metric,
    onMetric,
  }: {
    metric: HabitMetricTodayRow;
    onMetric: (itemId: number, value: string | null) => void;
  } = $props();

  const selectedIds = $derived(parseChoiceValue(metric.value ?? '') ?? []);

  function onTime(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    onMetric(metric.item.id, v === '' ? null : v);
  }

  function onNumber(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    onMetric(metric.item.id, v === '' ? null : v);
  }

  function toggleOption(optionId: number) {
    const list = selectedIds.includes(optionId)
      ? selectedIds.filter((id) => id !== optionId)
      : [...selectedIds, optionId];
    onMetric(metric.item.id, list.length === 0 ? null : choiceValue(list));
  }
</script>

<div class="metric" class:logged={metric.value !== null}>
  <span class="metric-name">{metric.item.name}</span>

  {#if metric.item.metricType === 'time'}
    <input
      type="time"
      class="metric-time"
      aria-label={`${metric.item.name} time`}
      value={metric.value ?? ''}
      onchange={onTime}
    />
  {:else if metric.item.metricType === 'number'}
    <input
      type="number"
      class="metric-number"
      inputmode="decimal"
      step="any"
      aria-label={`${metric.item.name} value`}
      value={metric.value ?? ''}
      onchange={onNumber}
    />
  {:else if metric.item.metricType === 'choice'}
    <div class="metric-choices" role="group" aria-label={`${metric.item.name} options`}>
      {#if metric.options.length === 0}
        <span class="no-options">No options yet — add some on the Habits tab.</span>
      {/if}
      {#each metric.options as option (option.id)}
        <button
          type="button"
          class="choice"
          class:on={selectedIds.includes(option.id)}
          aria-pressed={selectedIds.includes(option.id)}
          onclick={() => toggleOption(option.id)}
        >
          {option.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style lang="scss" src="./MetricInput.scss"></style>
