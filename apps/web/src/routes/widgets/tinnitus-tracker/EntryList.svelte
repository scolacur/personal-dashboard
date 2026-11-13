<script lang="ts">
  import type { TinnitusEntry } from '@dashboard/shared';
  import type { PendingEntry } from './queue';
  import { formatWhen } from './time';

  /** Recent entries, newest first. Queued (unsynced) ones are listed first and can't be edited yet. */
  interface Props {
    entries: TinnitusEntry[];
    pending: PendingEntry[];
    onEdit: (entry: TinnitusEntry) => void;
  }

  let { entries, pending, onEdit }: Props = $props();

  const queued = $derived([...pending].sort((a, b) => b.recordedAt - a.recordedAt));
</script>

{#if queued.length + entries.length > 0}
  <ul class="entries">
    {#each queued as p (p.clientId)}
      <li class="row pending">
        <span class="value">{p.intensity}</span>
        <span class="body">
          <span class="when">{formatWhen(p.recordedAt)} · <em>pending sync</em></span>
          {#if p.tags.length}<span class="tags">{p.tags.join(' · ')}</span>{/if}
          {#if p.notes}<span class="notes">{p.notes}</span>{/if}
        </span>
      </li>
    {/each}
    {#each entries as e (e.id)}
      <li>
        <button type="button" class="row" onclick={() => onEdit(e)} aria-label="Edit entry from {formatWhen(e.recordedAt)}">
          <span class="value">{e.intensity}</span>
          <span class="body">
            <span class="when">{formatWhen(e.recordedAt)}</span>
            {#if e.tags.length}<span class="tags">{e.tags.join(' · ')}</span>{/if}
            {#if e.notes}<span class="notes">{e.notes}</span>{/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="empty">No entries yet.</p>
{/if}

<style lang="scss" src="./EntryList.scss"></style>
