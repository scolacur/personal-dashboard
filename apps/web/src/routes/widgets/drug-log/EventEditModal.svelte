<script lang="ts">
  import { untrack } from 'svelte';
  import {
    DRUG_LOG_FUTURE_TOLERANCE_MS,
    type DrugLogDrug,
    type DrugLogEvent,
  } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import { createEvent, deleteEvent, updateEvent } from './api';
  import { activeDrugs, archivedDrugs } from './drug-log';
  import { newClientId } from './queue';
  import { fromLocalInput, toLocalInput } from './time';

  /**
   * Re-time, re-assign or delete one logged event — or, with `event` null and `addAt` set, add one
   * by hand to a past day (PD-975, Drug log widget). Online-only, like the Tinnitus edit modal:
   * only taps go through the offline outbox.
   */
  interface Props {
    open: boolean;
    event: DrugLogEvent | null;
    /** When adding: the initial time (unix ms) and drug. */
    addAt?: number;
    addDrugId?: number | null;
    drugs: DrugLogDrug[];
    onClose: () => void;
    onSaved: (event: DrugLogEvent) => void;
    onDeleted: (id: number) => void;
  }

  let {
    open,
    event,
    addAt = Date.now(),
    addDrugId = null,
    drugs,
    onClose,
    onSaved,
    onDeleted,
  }: Props = $props();

  let when = $state('');
  let drugId = $state<number | null>(null);
  let error = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  const active = $derived(activeDrugs(drugs));
  const archived = $derived(archivedDrugs(drugs));

  // Seed the form when it opens (or opens on another event); later prop churn — e.g. the drug
  // list refreshing — must not reset what's being edited.
  $effect(() => {
    if (!open) return;
    void event?.id;
    untrack(() => {
      when = toLocalInput(event?.recordedAt ?? addAt);
      drugId = event?.drugId ?? addDrugId ?? active[0]?.id ?? null;
      error = '';
      confirmDelete = false;
    });
  });

  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const recordedAt = fromLocalInput(when);
    if (recordedAt === null) {
      error = 'Pick a valid date and time.';
      return;
    }
    if (recordedAt > Date.now() + DRUG_LOG_FUTURE_TOLERANCE_MS) {
      error = "That time hasn't happened yet.";
      return;
    }
    if (drugId === null) {
      error = 'Pick a button.';
      return;
    }
    busy = true;
    error = '';
    try {
      onSaved(
        event
          ? await updateEvent(event.id, { recordedAt, drugId })
          : await createEvent({ clientId: newClientId(), drugId, recordedAt }),
      );
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    if (!event) return;
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    busy = true;
    try {
      await deleteEvent(event.id);
      onDeleted(event.id);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title={event ? 'Edit entry' : 'Add entry'} {onClose}>
  <form class="event-form" onsubmit={save}>
    <label>
      <span>Drug</span>
      <select bind:value={drugId}>
        {#each active as d (d.id)}
          <option value={d.id}>{d.label}</option>
        {/each}
        {#if archived.length > 0}
          <optgroup label="Archived">
            {#each archived as d (d.id)}
              <option value={d.id}>{d.label}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>

    <label>
      <span>When</span>
      <input type="datetime-local" bind:value={when} max={toLocalInput(Date.now())} />
    </label>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      {#if event}
        <button
          type="button"
          class="delete"
          class:confirm={confirmDelete}
          disabled={busy}
          onclick={remove}
        >
          {confirmDelete ? 'Tap again to delete' : 'Delete'}
        </button>
      {/if}
      <button type="button" class="cancel" disabled={busy} onclick={onClose}>Cancel</button>
      <button type="submit" class="save" disabled={busy}>{event ? 'Save' : 'Add'}</button>
    </div>
  </form>
</Modal>

<style lang="scss" src="./EventEditModal.scss"></style>
