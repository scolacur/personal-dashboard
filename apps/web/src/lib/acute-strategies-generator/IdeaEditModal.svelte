<script lang="ts">
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';

  interface Props {
    idea?: AcuteStrategyIdea | null;
    onSave: (data: { text: string; type: IdeaType; tags: string[] }) => Promise<void>;
    onCancel: () => void;
  }

  let { idea = null, onSave, onCancel }: Props = $props();

  let text = $state(idea?.text ?? '');
  let type = $state<IdeaType>(idea?.type ?? 'Acute');
  let tagsInput = $state((idea?.tags ?? []).join(', '));
  let saving = $state(false);
  let error = $state('');

  async function handleSubmit() {
    if (!text.trim()) {
      error = 'Text is required.';
      return;
    }
    error = '';
    saving = true;
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await onSave({ text: text.trim(), type, tags });
    } catch {
      error = 'Failed to save. Please try again.';
      saving = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={handleBackdrop}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={idea ? 'Edit idea' : 'New idea'}>
    <h2 class="modal-title">{idea ? 'Edit Idea' : 'New Idea'}</h2>

    <label class="field">
      <span class="label">Text</span>
      <textarea class="textarea" rows="4" bind:value={text} disabled={saving}></textarea>
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
      <button class="btn-primary" onclick={handleSubmit} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</div>

<style lang="scss" src="./IdeaEditModal.scss"></style>
