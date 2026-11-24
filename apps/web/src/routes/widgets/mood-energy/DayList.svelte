<script lang="ts">
  import { energyColor, energyLabel, moodLabel, scale15Color, SCALE_1_5_INK } from '@dashboard/shared';
  import { formatDay, type DayEntry } from './days';

  /** Logged days, newest first, with mood and energy labels, tags and a note snippet. Tap to edit. */
  interface Props {
    entries: DayEntry[];
    onEdit: (entry: DayEntry) => void;
  }

  let { entries, onEdit }: Props = $props();
</script>

{#if entries.length > 0}
  <ul class="days">
    {#each entries as e (e.day)}
      <li>
        <button type="button" class="row" class:pending={e.pending} onclick={() => onEdit(e)} aria-label="Edit {formatDay(e.day, { year: true })}">
          <span class="score" style:background={scale15Color(e.mood)} style:color={SCALE_1_5_INK}>{e.mood}</span>
          <span class="body">
            <span class="head">
              <strong>{formatDay(e.day)}</strong>
              <span class="label">{moodLabel(e.mood)}</span>
              <span class="energy"><i style:background={energyColor(e.energy)}></i>{energyLabel(e.energy)}</span>
              {#if e.pending}<em class="label">pending sync</em>{/if}
            </span>
            {#if e.tags.length}
              <span class="tags">
                {#each e.tags as t (t)}<span class="tag">{t}</span>{/each}
              </span>
            {/if}
            {#if e.note}<span class="note">{e.note}</span>{/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">No days logged yet.</p>
{/if}

<style lang="scss" src="./DayList.scss"></style>
