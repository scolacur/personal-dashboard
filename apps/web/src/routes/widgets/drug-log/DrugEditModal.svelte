<script lang="ts">
  import { untrack } from 'svelte';
  import {
    contrastText,
    DRUG_LOG_LABEL_MAX_LENGTH,
    normalizeDrugLabel,
    type DrugLogDrug,
  } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import ColorPicker from '$lib/ColorPicker.svelte';
  import { labelScale } from './drug-log';

  /**
   * Add or edit one button (PD-975, Drug log widget): label + colour, and — for an existing button —
   * move, archive and delete. The modal only gathers intent; `ButtonsPanel` makes the API calls.
   */
  interface Props {
    open: boolean;
    /** Null to add a new button. */
    drug: DrugLogDrug | null;
    canMoveEarlier?: boolean;
    canMoveLater?: boolean;
    onClose: () => void;
    onSave: (input: { label: string; color: string }) => Promise<void>;
    onMove?: (delta: -1 | 1) => Promise<void>;
    onArchive?: () => Promise<void>;
    onDelete?: () => Promise<void>;
  }

  let {
    open,
    drug,
    canMoveEarlier = false,
    canMoveLater = false,
    onClose,
    onSave,
    onMove,
    onArchive,
    onDelete,
  }: Props = $props();

  const NEW_COLOR = '#2f6fb5';

  let label = $state('');
  let color = $state(NEW_COLOR);
  let error = $state('');
  let busy = $state(false);
  let confirmDelete = $state(false);

  // Re-seed whenever the modal opens on a (possibly different) button. Keyed on `open` and the
  // drug's id only, so a move (which updates the drug's sortOrder) doesn't wipe unsaved edits.
  $effect(() => {
    if (!open) return;
    void drug?.id;
    untrack(() => {
      label = drug?.label ?? '';
      color = drug?.color ?? NEW_COLOR;
      error = '';
      confirmDelete = false;
    });
  });

  const cleanLabel = $derived(normalizeDrugLabel(label));
  const labelOk = $derived(
    cleanLabel !== '' && [...cleanLabel].length <= DRUG_LOG_LABEL_MAX_LENGTH,
  );

  async function run(fn: () => Promise<void>): Promise<void> {
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function save(e: SubmitEvent): void {
    e.preventDefault();
    if (!labelOk) {
      error = `Give it a label of 1–${DRUG_LOG_LABEL_MAX_LENGTH} characters.`;
      return;
    }
    void run(() => onSave({ label: cleanLabel, color }));
  }

  function remove(): void {
    if (!confirmDelete) {
      confirmDelete = true;
      return;
    }
    if (onDelete) void run(onDelete);
  }

  const deleteText = $derived.by(() => {
    if (!drug) return '';
    const n = drug.eventCount;
    return `Delete ${drug.label} and its ${n} ${n === 1 ? 'entry' : 'entries'}?`;
  });
</script>

<Modal {open} title={drug ? `Edit ${drug.label}` : 'Add a button'} {onClose}>
  <form class="drug-form" onsubmit={save}>
    <div class="preview-row">
      <span
        class="preview"
        style:--drug-color={color}
        style:--drug-text={contrastText(color)}
        style:--label-scale={labelScale(cleanLabel || '?')}
        aria-hidden="true"><span>{cleanLabel || '?'}</span></span
      >
      <label class="field">
        <span>Label</span>
        <input
          type="text"
          bind:value={label}
          maxlength={DRUG_LOG_LABEL_MAX_LENGTH + 4}
          placeholder="e.g. Weed"
          autocomplete="off"
          aria-invalid={label !== '' && !labelOk}
        />
        <small>{[...cleanLabel].length}/{DRUG_LOG_LABEL_MAX_LENGTH}</small>
      </label>
    </div>

    <div class="field">
      <span>Colour</span>
      <ColorPicker bind:value={color} label="Button colour" />
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if drug}
      <div class="secondary">
        <div class="move" role="group" aria-label="Position">
          <button
            type="button"
            disabled={busy || !canMoveEarlier}
            onclick={() => onMove && run(() => onMove(-1))}
          >
            ← Earlier
          </button>
          <button
            type="button"
            disabled={busy || !canMoveLater}
            onclick={() => onMove && run(() => onMove(1))}
          >
            Later →
          </button>
        </div>
        {#if onArchive}
          <button type="button" disabled={busy} onclick={() => onArchive && run(onArchive)}
            >Archive</button
          >
        {/if}
      </div>
      {#if confirmDelete}
        <p class="confirm-text" role="alert">{deleteText} This can't be undone.</p>
      {/if}
    {/if}

    <div class="actions">
      {#if drug}
        <button
          type="button"
          class="delete"
          class:confirm={confirmDelete}
          disabled={busy}
          onclick={remove}
        >
          {confirmDelete ? 'Yes, delete' : 'Delete'}
        </button>
      {/if}
      <button type="button" class="cancel" disabled={busy} onclick={onClose}>Cancel</button>
      <button type="submit" class="save" disabled={busy}>{drug ? 'Save' : 'Add'}</button>
    </div>
  </form>
</Modal>

<style lang="scss" src="./DrugEditModal.scss"></style>
