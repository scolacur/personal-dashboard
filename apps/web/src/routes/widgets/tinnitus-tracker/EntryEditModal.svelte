<script lang="ts">
  import { TINNITUS_MAX, TINNITUS_MIN, tinnitusLabel, type TinnitusEntry } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import TagCloud from './TagCloud.svelte';
  import { deleteEntry, updateEntry } from './api';
  import { fromLocalInput, toLocalInput } from './time';

  interface Props {
    entry: TinnitusEntry | null;
    /** The cloud's visible tags. The entry's own tags are added, so a hidden one can still be removed. */
    tags: string[];
    onClose: () => void;
    onSaved: (entry: TinnitusEntry) => void;
    onDeleted: (id: number) => void;
  }

  let { entry, tags, onClose, onSaved, onDeleted }: Props = $props();

  let intensity = $state(0);
  let selected = $state<string[]>([]);
  let when = $state('');
  let notes = $state('');
  let error = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  // Re-seed the form whenever a different entry opens.
  $effect(() => {
    if (!entry) return;
    intensity = entry.intensity;
    selected = [...entry.tags];
    when = toLocalInput(entry.recordedAt);
    notes = entry.notes ?? '';
    error = '';
    confirmDelete = false;
  });

  const allTags = $derived(entry ? [...tags, ...entry.tags.filter((t) => !tags.includes(t))] : tags);

  async function save() {
    if (!entry) return;
    const recordedAt = fromLocalInput(when);
    if (recordedAt === null) {
      error = 'Pick a valid date and time.';
      return;
    }
    busy = true;
    error = '';
    try {
      onSaved(await updateEntry(entry.id, { intensity, tags: selected, notes: notes.trim() || null, recordedAt }));
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!entry) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    busy = true;
    try {
      await deleteEntry(entry.id);
      onDeleted(entry.id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal open={entry !== null} title="Edit entry" {onClose}>
  <div class="form">
    <div class="stepper">
      <button type="button" aria-label="Lower" disabled={intensity <= TINNITUS_MIN} onclick={() => intensity--}>−</button>
      <span class="value" aria-live="polite">{intensity}</span>
      <button type="button" aria-label="Raise" disabled={intensity >= TINNITUS_MAX} onclick={() => intensity++}>+</button>
    </div>
    <p class="label">{tinnitusLabel(intensity) ?? '\u00a0'}</p>

    <TagCloud tags={allTags} bind:selected compact />

    <label>
      <span>When</span>
      <input type="datetime-local" bind:value={when} />
    </label>

    <label>
      <span>Notes</span>
      <textarea rows="3" bind:value={notes}></textarea>
    </label>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="delete" class:confirm={confirmDelete} disabled={busy} onclick={remove}>
        {confirmDelete ? 'Tap again to delete' : 'Delete'}
      </button>
      <button type="button" class="save" disabled={busy} onclick={save}>Save</button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./EntryEditModal.scss"></style>
