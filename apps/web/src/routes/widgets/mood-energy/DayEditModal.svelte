<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import MoodEnergyForm from './MoodEnergyForm.svelte';
  import { deleteEntry } from './api';
  import { blankDraft, draftFromEntry, formatDay, type DayDraft, type DayEntry } from './days';

  /**
   * Edit or delete a day from the calendar or list — or, for an empty day, log one. Saving is the
   * same upsert-by-day as the capture, so it goes through the page's outbox (`onSave`). Deleting is
   * a direct call; a day that has never reached the server can't be deleted until it syncs.
   */
  export interface EditTarget {
    day: string;
    entry: DayEntry | null;
  }

  interface Props {
    target: EditTarget | null;
    tags: string[];
    onClose: () => void;
    onSave: (day: string, draft: DayDraft) => void;
    onDeleted: (day: string) => void;
  }

  let { target, tags, onClose, onSave, onDeleted }: Props = $props();

  let draft = $state<DayDraft>(blankDraft());
  let error = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  // Re-seed the form whenever a different day opens.
  $effect(() => {
    if (!target) return;
    draft = draftFromEntry(target.entry);
    error = '';
    confirmDelete = false;
  });

  const deletable = $derived(target?.entry != null && target.entry.id > 0);

  async function remove() {
    if (!target?.entry || !deletable) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    busy = true;
    try {
      await deleteEntry(target.entry.id);
      onDeleted(target.day);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal open={target !== null} title={target ? `${target.entry ? '' : 'Log '}${formatDay(target.day, { year: true })}` : ''} {onClose}>
  <div class="form">
    <MoodEnergyForm bind:draft {tags} compact addableTags={false} />

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      {#if deletable}
        <button type="button" class="delete" class:confirm={confirmDelete} disabled={busy} onclick={remove}>
          {confirmDelete ? 'Tap again to delete' : 'Delete'}
        </button>
      {:else}
        <span></span>
      {/if}
      <button type="button" class="save" disabled={busy} onclick={() => target && onSave(target.day, draft)}>Save</button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./DayEditModal.scss"></style>
