<script lang="ts">
  import {
    energyColor,
    energyLabel,
    moodLabel,
    normalizeTagName,
    scale15Color,
    MOOD_ENERGY_MAX,
    MOOD_ENERGY_MIN,
    MOOD_ENERGY_NOTE_MAX_LENGTH,
    MOOD_ENERGY_TAG_MAX_LENGTH,
    SCALE_1_5_INK,
  } from '@dashboard/shared';
  import RangeSlider from '$lib/RangeSlider.svelte';
  import TagCloud from '$lib/TagCloud.svelte';
  import type { DayDraft } from './days';

  /**
   * The fields of one day: mood and energy sliders (each with a big value and its rubric word), the
   * feeling-tag cloud and a note. Shared by the capture (page and card) and the calendar's edit
   * dialog, so they can never drift apart.
   */
  interface Props {
    draft: DayDraft;
    /** Tag names shown in the cloud. */
    tags: string[];
    compact?: boolean;
    /** Tag cloud edit mode (hide): page capture only. */
    editableTags?: boolean;
    addableTags?: boolean;
    noteRows?: number;
    onAddTag?: (name: string) => void;
    onHideTag?: (name: string) => void;
  }

  let {
    draft = $bindable(),
    tags,
    compact = false,
    editableTags = false,
    addableTags = true,
    noteRows = 3,
    onAddTag,
    onHideTag,
  }: Props = $props();

  // Tags already on this day stay visible even if hidden from the cloud, so they can be removed.
  const shownTags = $derived([...tags, ...draft.tags.filter((t) => !tags.includes(t))]);
</script>

<div class="day-form" class:compact>
  <div class="scale" style:--level={scale15Color(draft.mood)} style:--level-ink={SCALE_1_5_INK}>
    <output class="value-block" aria-live="polite">
      <span class="name">Mood</span>
      <span class="value">{draft.mood}</span>
      <span class="label">{moodLabel(draft.mood)}</span>
    </output>
    <RangeSlider
      bind:value={draft.mood}
      min={MOOD_ENERGY_MIN}
      max={MOOD_ENERGY_MAX}
      orientation="horizontal"
      label="Mood"
      color={scale15Color(draft.mood)}
      {compact}
    />
  </div>

  <div class="scale" style:--level={energyColor(draft.energy)} style:--level-ink={SCALE_1_5_INK}>
    <output class="value-block" aria-live="polite">
      <span class="name">Energy</span>
      <span class="value">{draft.energy}</span>
      <span class="label">{energyLabel(draft.energy)}</span>
    </output>
    <RangeSlider
      bind:value={draft.energy}
      min={MOOD_ENERGY_MIN}
      max={MOOD_ENERGY_MAX}
      orientation="horizontal"
      label="Energy"
      color={energyColor(draft.energy)}
      {compact}
    />
  </div>

  <TagCloud
    tags={shownTags}
    bind:selected={draft.tags}
    {compact}
    editable={editableTags}
    addable={addableTags}
    normalize={normalizeTagName}
    maxLength={MOOD_ENERGY_TAG_MAX_LENGTH}
    onAdd={onAddTag}
    onHide={onHideTag}
  />

  <textarea
    class="note"
    rows={noteRows}
    maxlength={MOOD_ENERGY_NOTE_MAX_LENGTH}
    placeholder="Note"
    aria-label="Note"
    bind:value={draft.note}
  ></textarea>
</div>

<style lang="scss" src="./MoodEnergyForm.scss"></style>
