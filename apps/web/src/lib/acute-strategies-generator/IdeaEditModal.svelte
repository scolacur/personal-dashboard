<script lang="ts">
  import { tick } from 'svelte';
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';
  import { parseIdeaForm } from './utils';

  interface Props {
    idea?: AcuteStrategyIdea | null;
    /** Persist the idea and refresh the list. Throws on failure; does not close the modal. */
    onSave: (data: { text: string; type: IdeaType; tags: string[] }) => Promise<void>;
    onCancel: () => void;
  }

  let { idea = null, onSave, onCancel }: Props = $props();

  // Create mode when there is no existing idea to edit.
  const isCreate = $derived(idea == null);

  let text = $state(idea?.text ?? '');
  let type = $state<IdeaType>(idea?.type ?? 'Acute');
  let tagsInput = $state((idea?.tags ?? []).join(', '));
  let saving = $state(false);
  let error = $state('');

  let textareaEl: HTMLTextAreaElement | undefined = $state();

  function resetForm() {
    text = '';
    type = 'Acute';
    tagsInput = '';
  }

  // `addAnother` saves then clears the form, keeping the modal open (create mode only, T546).
  async function handleSubmit(addAnother = false) {
    const parsed = parseIdeaForm(text, type, tagsInput);
    if (!parsed.ok) {
      error = parsed.error;
      return;
    }
    error = '';
    saving = true;
    try {
      await onSave(parsed.data);
      if (addAnother) {
        resetForm();
        saving = false;
        await tick();
        textareaEl?.focus();
      } else {
        // A single save closes the modal; the parent owns that.
        onCancel();
      }
    } catch {
      // Keep the entered text so the user can retry without re-typing.
      error = 'Failed to save. Please try again.';
      saving = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={handleBackdrop}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={isCreate ? 'New idea' : 'Edit idea'}>
    <h2 class="modal-title">{isCreate ? 'New Idea' : 'Edit Idea'}</h2>

    <label class="field">
      <span class="label">Text</span>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="textarea"
        rows="4"
        bind:value={text}
        bind:this={textareaEl}
        disabled={saving}
        autofocus
      ></textarea>
    </label>

    <label class="field">
      <span class="label">Type</span>
      <select class="select" bind:value={type} disabled={saving}>
        {#each IDEA_TYPES as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="label">Tags <span class="hint">(comma-separated)</span></span>
      <input class="input" type="text" bind:value={tagsInput} disabled={saving} placeholder="e.g. synth, ambient" />
    </label>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button class="btn-secondary" onclick={onCancel} disabled={saving}>Cancel</button>
      {#if isCreate}
        <button class="btn-secondary" onclick={() => handleSubmit(true)} disabled={saving}>
          Save and add another
        </button>
      {/if}
      <button class="btn-primary" onclick={() => handleSubmit(false)} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</div>

<style lang="scss" src="./IdeaEditModal.scss"></style>
