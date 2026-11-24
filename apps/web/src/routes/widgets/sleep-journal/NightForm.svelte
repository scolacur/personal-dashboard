<script lang="ts">
  import {
    normalizeSleepTagName,
    scale15Color,
    sleepRestedLabel,
    SLEEP_NOTES_MAX_LENGTH,
    SLEEP_RESTED_MAX,
    SCALE_1_5_INK,
    SLEEP_RESTED_MIN,
    SLEEP_TAG_COUNT_MAX,
    SLEEP_TAG_MAX_LENGTH,
  } from '@dashboard/shared';
  import RangeSlider from '$lib/RangeSlider.svelte';
  import TagCloud from '$lib/TagCloud.svelte';
  import { draftTimes, type NightDraft } from './draft';
  import { formatDuration, formatWakeDate, todayWakeDate } from './time';

  /**
   * The fields of one night: sleep → wake times with a live duration, the rested slider, counted
   * tags and dream notes. Shared by the capture form (page and card) and the edit dialog, so the
   * three can never drift apart.
   */
  interface Props {
    draft: NightDraft;
    /** Tag names shown in the cloud. */
    tags: string[];
    compact?: boolean;
    /**
     * The wake-date control: none (the card — always today), a "Today ▾" toggle (page capture, for
     * backfilling a missed night), or always shown (the edit dialog).
     */
    dateMode?: 'none' | 'toggle' | 'always';
    /** Tag cloud edit mode (hide) — page capture only. */
    editableTags?: boolean;
    addableTags?: boolean;
    onAddTag?: (name: string) => void;
    onHideTag?: (name: string) => void;
  }

  let {
    draft = $bindable(),
    tags,
    compact = false,
    dateMode = 'none',
    editableTags = false,
    addableTags = true,
    onAddTag,
    onHideTag,
  }: Props = $props();

  const today = todayWakeDate();
  let pickingDate = $state(false);
  const showDate = $derived(dateMode === 'always' || (dateMode === 'toggle' && (pickingDate || draft.wakeDate !== today)));

  // The live duration. Future-ness is checked on save, not here, so typing never blanks it.
  const duration = $derived.by(() => {
    const t = draftTimes(draft, Number.POSITIVE_INFINITY);
    return t.ok ? formatDuration(t.wakeAt - t.sleepAt) : '–';
  });

  // Tags already on this night stay visible even if hidden from the cloud, so they can be removed.
  const shownTags = $derived([...tags, ...Object.keys(draft.counts).filter((t) => !tags.includes(t))]);

  function resetDate() {
    pickingDate = false;
    draft.wakeDate = today;
  }
</script>

<div class="night-form" class:compact>
  <div class="times">
    <label class="time">
      <span>Asleep</span>
      <input type="time" bind:value={draft.sleepTime} aria-label="Went to sleep at" />
    </label>
    <span class="arrow" aria-hidden="true">→</span>
    <label class="time">
      <span>Awake</span>
      <input type="time" bind:value={draft.wakeTime} aria-label="Woke at" />
    </label>
    <output class="duration" aria-label="Duration">{duration}</output>
  </div>

  {#if dateMode !== 'none'}
    <div class="date">
      {#if showDate}
        <label>
          <span>Woke on</span>
          <input type="date" bind:value={draft.wakeDate} max={today} aria-label="Wake date" />
        </label>
        {#if dateMode === 'toggle'}
          <button type="button" class="link" onclick={resetDate}>Today</button>
        {/if}
      {:else}
        <button type="button" class="link" aria-expanded="false" onclick={() => (pickingDate = true)}>
          Woke today ({formatWakeDate(today)}) ▾
        </button>
      {/if}
    </div>
  {/if}

  <div class="rested" style:--rested={scale15Color(draft.rested)} style:--rested-ink={SCALE_1_5_INK}>
    <output class="value-block" aria-live="polite">
      <span class="value">{draft.rested}</span>
      <span class="label">{sleepRestedLabel(draft.rested)}</span>
    </output>
    <RangeSlider
      bind:value={draft.rested}
      min={SLEEP_RESTED_MIN}
      max={SLEEP_RESTED_MAX}
      orientation="horizontal"
      label="How rested"
      color={scale15Color(draft.rested)}
      {compact}
    />
  </div>

  <TagCloud
    tags={shownTags}
    bind:counts={draft.counts}
    counted
    maxCount={SLEEP_TAG_COUNT_MAX}
    {compact}
    editable={editableTags}
    addable={addableTags}
    normalize={normalizeSleepTagName}
    maxLength={SLEEP_TAG_MAX_LENGTH}
    onAdd={onAddTag}
    onHide={onHideTag}
  />

  <textarea
    class="notes"
    rows={compact ? 2 : 4}
    maxlength={SLEEP_NOTES_MAX_LENGTH}
    placeholder="Dream notes"
    aria-label="Dream notes"
    bind:value={draft.notes}
  ></textarea>
</div>

<style lang="scss" src="./NightForm.scss"></style>
