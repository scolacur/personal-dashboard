<script lang="ts">
  import type { DrugLogDrug, DrugLogEvent } from '@dashboard/shared';
  import { formatTime } from './time';

  /** One day's events, newest first, each with an Edit button (re-time / re-assign / delete). */
  interface Props {
    events: DrugLogEvent[];
    drugsById: Map<number, DrugLogDrug>;
    onEdit: (event: DrugLogEvent) => void;
  }

  let { events, drugsById, onEdit }: Props = $props();
</script>

{#if events.length === 0}
  <p class="none">Nothing logged.</p>
{:else}
  <ul class="event-list">
    {#each events as e (e.id)}
      {@const drug = drugsById.get(e.drugId)}
      <li>
        <time datetime={new Date(e.recordedAt).toISOString()}>{formatTime(e.recordedAt)}</time>
        <span class="dot" style:background={drug?.color ?? 'var(--muted)'} aria-hidden="true"
        ></span>
        <span class="name">{drug?.label ?? 'Unknown'}</span>
        <button
          type="button"
          aria-label={`Edit ${drug?.label ?? 'entry'} at ${formatTime(e.recordedAt)}`}
          onclick={() => onEdit(e)}
        >
          Edit
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style lang="scss" src="./EventList.scss"></style>
