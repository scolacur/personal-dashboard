<script lang="ts">
  import { sleepRestedColor, sleepRestedLabel, sleepWakeDate, SLEEP_RESTED_INK, type SleepEntry, type SleepTagCount } from '@dashboard/shared';
  import type { PendingNight } from './queue';
  import { formatClock, formatDuration, formatWakeDate } from './time';

  /** Nights, newest first. Queued (unsynced) saves are listed first and can't be edited yet. */
  interface Props {
    entries: SleepEntry[];
    pending: PendingNight[];
    onEdit: (entry: SleepEntry) => void;
  }

  let { entries, pending, onEdit }: Props = $props();

  const queued = $derived([...pending].sort((a, b) => b.wakeAt - a.wakeAt));
  const tagText = (t: SleepTagCount) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name);
</script>

{#snippet row(wakeDate: string, sleepAt: number, wakeAt: number, rested: number, tags: SleepTagCount[], notes: string | null | undefined, isPending: boolean)}
  <span class="score" style:background={sleepRestedColor(rested)} style:color={SLEEP_RESTED_INK}>{rested}</span>
  <span class="body">
    <span class="head">
      <strong>{formatWakeDate(wakeDate)}</strong>
      <span class="label">{sleepRestedLabel(rested)}</span>
    </span>
    <span class="when">
      {formatClock(sleepAt)} → {formatClock(wakeAt)} · {formatDuration(wakeAt - sleepAt)}
      {#if isPending}· <em>pending sync</em>{/if}
    </span>
    {#if tags.length}
      <span class="tags">
        {#each tags as t (t.name)}<span class="tag">{tagText(t)}</span>{/each}
      </span>
    {/if}
    {#if notes}<span class="notes">{notes}</span>{/if}
  </span>
{/snippet}

{#if queued.length + entries.length > 0}
  <ul class="nights">
    {#each queued as p (p.clientId)}
      <li class="row pending">
        {@render row(sleepWakeDate(p.wakeAt), p.sleepAt, p.wakeAt, p.rested, p.tags, p.notes, true)}
      </li>
    {/each}
    {#each entries as e (e.id)}
      <li>
        <button type="button" class="row" onclick={() => onEdit(e)} aria-label="Edit the night of {formatWakeDate(e.wakeDate)}">
          {@render row(e.wakeDate, e.sleepAt, e.wakeAt, e.rested, e.tags, e.notes, false)}
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">No nights logged yet.</p>
{/if}

<style lang="scss" src="./NightList.scss"></style>
