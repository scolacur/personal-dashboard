<script lang="ts">
  import {
    DAYS_OF_WEEK_ALL,
    HABIT_WEEKDAY_NAMES,
    MAX_PER_WEEK_N,
    weekdayInMask,
    type HabitSchedule,
    type HabitScheduleKind,
    type SetHabitScheduleInput,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';

  /**
   * Edit a habit's schedule (PD-722, D-095). The change applies from today — the store inserts a new
   * effective-dated row and never rewrites history. Days-of-week picks a weekday mask; per-week picks
   * a target N (completions per Mon–Sun week).
   */
  let {
    name,
    schedule,
    onSave,
    onClose,
  }: {
    name: string;
    schedule: HabitSchedule | null;
    onSave: (input: SetHabitScheduleInput) => Promise<void>;
    onClose: () => void;
  } = $props();

  let kind = $state<HabitScheduleKind>(schedule?.kind ?? 'days_of_week');
  let daysMask = $state<number>(
    schedule?.kind === 'days_of_week' ? (schedule.daysMask ?? DAYS_OF_WEEK_ALL) : DAYS_OF_WEEK_ALL,
  );
  let perWeekN = $state<number>(schedule?.kind === 'per_week' ? (schedule.perWeekN ?? 3) : 3);
  let saving = $state(false);

  function toggleDay(index: number) {
    daysMask ^= 1 << index;
  }

  const canSave = $derived(kind === 'per_week' || daysMask > 0);

  async function save() {
    if (!canSave || saving) return;
    saving = true;
    try {
      await onSave(
        kind === 'days_of_week' ? { kind, daysMask } : { kind, perWeekN },
      );
      onClose();
    } finally {
      saving = false;
    }
  }
</script>

<Modal open title={`Schedule — ${name}`} onClose={onClose}>
  <div class="schedule-editor">
    <div class="kind-toggle" role="group" aria-label="Schedule kind">
      <button type="button" class:active={kind === 'days_of_week'} onclick={() => (kind = 'days_of_week')}>
        Days of week
      </button>
      <button type="button" class:active={kind === 'per_week'} onclick={() => (kind = 'per_week')}>
        N times per week
      </button>
    </div>

    {#if kind === 'days_of_week'}
      <div class="weekdays" role="group" aria-label="Due weekdays">
        {#each HABIT_WEEKDAY_NAMES as dayName, i (dayName)}
          <button
            type="button"
            class="weekday"
            class:on={weekdayInMask(daysMask, i)}
            aria-pressed={weekdayInMask(daysMask, i)}
            onclick={() => toggleDay(i)}
          >
            {dayName}
          </button>
        {/each}
      </div>
      {#if daysMask === 0}
        <p class="hint error">Pick at least one day.</p>
      {/if}
    {:else}
      <label class="per-week">
        <span>Times per week</span>
        <input type="number" min="1" max={MAX_PER_WEEK_N} bind:value={perWeekN} />
      </label>
    {/if}

    <p class="hint">The change applies from today; past days keep their old schedule.</p>

    <div class="modal-actions">
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!canSave || saving} onclick={save}>Save</Button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./ScheduleEditor.scss"></style>
