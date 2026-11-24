<script lang="ts">
  import type { CreateSleepEntryInput, SleepEntry } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import NightForm from './NightForm.svelte';
  import { deleteEntry, updateEntry } from './api';
  import { blankDraft, draftFromEntry, draftTimes, tagsFromCounts, type NightDraft } from './draft';
  import { newClientId } from './queue';
  import { formatClock, formatWakeDate } from './time';

  /**
   * Edit (every field) or delete a night — or, for an empty calendar night, log one for that date.
   * An edit is a direct PATCH, like the Tinnitus Tracker's; a new night goes through the page's
   * outbox (`onQueue`), like any capture.
   */
  export interface EditTarget {
    date: string;
    entry: SleepEntry | null;
  }

  interface Props {
    target: EditTarget | null;
    tags: string[];
    /** The latest night, whose times prefill a new one. */
    previous: SleepEntry | null;
    onClose: () => void;
    onSaved: (entry: SleepEntry) => void;
    onDeleted: (id: number) => void;
    onQueue: (input: CreateSleepEntryInput) => void;
  }

  let { target, tags, previous, onClose, onSaved, onDeleted, onQueue }: Props = $props();

  let draft = $state<NightDraft>(blankDraft(null));
  let error = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  // Re-seed the form whenever a different night opens.
  $effect(() => {
    if (!target) return;
    if (target.entry) {
      draft = draftFromEntry(target.entry);
    } else {
      draft = {
        ...blankDraft(previous),
        wakeDate: target.date,
        wakeTime: previous ? formatClock(previous.wakeAt) : '07:00',
      };
    }
    error = '';
    confirmDelete = false;
  });

  async function save() {
    if (!target) return;
    const t = draftTimes(draft);
    if (!t.ok) {
      error = t.error;
      return;
    }
    const fields = {
      sleepAt: t.sleepAt,
      wakeAt: t.wakeAt,
      rested: draft.rested,
      tags: tagsFromCounts(draft.counts),
      notes: draft.notes.trim() || null,
    };
    if (!target.entry) {
      onQueue({ clientId: newClientId(), ...fields });
      return;
    }
    busy = true;
    error = '';
    try {
      onSaved(await updateEntry(target.entry.id, fields));
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!target?.entry) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    busy = true;
    try {
      await deleteEntry(target.entry.id);
      onDeleted(target.entry.id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  open={target !== null}
  title={target ? `${target.entry ? 'Night of' : 'Log the night of'} ${formatWakeDate(target.date)}` : ''}
  {onClose}
>
  <div class="form">
    <NightForm bind:draft {tags} compact dateMode="always" addableTags={false} />

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      {#if target?.entry}
        <button type="button" class="delete" class:confirm={confirmDelete} disabled={busy} onclick={remove}>
          {confirmDelete ? 'Tap again to delete' : 'Delete'}
        </button>
      {:else}
        <span></span>
      {/if}
      <button type="button" class="save" disabled={busy} onclick={save}>Save</button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./NightEditModal.scss"></style>
