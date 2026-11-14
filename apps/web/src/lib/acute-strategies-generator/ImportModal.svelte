<script lang="ts">
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';
  import { parseLines, dedupeLines } from './import-export';

  interface Props {
    /** Existing idea texts, used to preview duplicates before committing. */
    existingTexts: string[];
    /** Commit the batch; returns the created ideas for the parent to append. Throws on failure. */
    onImport: (lines: string[], type: IdeaType, tags: string[]) => Promise<AcuteStrategyIdea[]>;
    onCancel: () => void;
  }

  let { existingTexts, onImport, onCancel }: Props = $props();

  let rawText = $state('');
  let type = $state<IdeaType>('Acute');
  let tagsInput = $state('');
  let importing = $state(false);
  let error = $state('');
  let fileName = $state('');

  const lines = $derived(parseLines(rawText));
  const preview = $derived(dedupeLines(lines, existingTexts));

  async function handleFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileName = file.name;
    rawText = await file.text();
  }

  function parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async function handleImport() {
    if (preview.toAdd.length === 0) {
      error = 'Nothing to import.';
      return;
    }
    error = '';
    importing = true;
    try {
      await onImport(preview.toAdd, type, parseTags(tagsInput));
      onCancel();
    } catch {
      error = 'Failed to import. Please try again.';
      importing = false;
    }
  }

  function handleBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={handleBackdrop}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Import ideas">
    <h2 class="modal-title">Import Ideas</h2>
    <p class="hint">One idea per line. Choose a file or paste below.</p>

    <label class="field">
      <span class="label">File <span class="hint">(.txt)</span></span>
      <input class="file" type="file" accept=".txt,text/plain" onchange={handleFile} disabled={importing} />
      {#if fileName}
        <span class="file-name">{fileName}</span>
      {/if}
    </label>

    <label class="field">
      <span class="label">Lines</span>
      <textarea
        class="textarea"
        rows="8"
        bind:value={rawText}
        disabled={importing}
        placeholder="One idea per line"
      ></textarea>
    </label>

    <label class="field">
      <span class="label">Type <span class="hint">(applied to the whole batch)</span></span>
      <select class="select" bind:value={type} disabled={importing}>
        {#each IDEA_TYPES as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="label">Tags <span class="hint">(comma-separated, whole batch)</span></span>
      <input class="input" type="text" bind:value={tagsInput} disabled={importing} placeholder="e.g. synth, ambient" />
    </label>

    <p class="preview">
      {preview.toAdd.length} to add, {preview.skipped} duplicate{preview.skipped !== 1 ? 's' : ''} skipped
    </p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button class="btn-secondary" onclick={onCancel} disabled={importing}>Cancel</button>
      <button class="btn-primary" onclick={handleImport} disabled={importing || preview.toAdd.length === 0}>
        {importing ? 'Importing…' : `Import ${preview.toAdd.length}`}
      </button>
    </div>
  </div>
</div>

<style lang="scss" src="./ImportModal.scss"></style>
