<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';
  import {
    coerceValue,
    validateDraft,
    type Draft,
    type FieldDef,
  } from './list-manager';

  // The add/edit form for ListManager (PD-441). Built entirely from the field descriptors —
  // it knows nothing about what it is editing. Mounted only while open, so the draft seeds
  // itself on mount and needs no reset effect.
  let {
    title,
    fields,
    initial,
    onSave,
    onCancel,
  }: {
    title: string;
    fields: FieldDef[];
    initial: Draft;
    onSave: (draft: Draft) => Promise<void> | void;
    onCancel: () => void;
  } = $props();

  // Seeded once, deliberately: the parent mounts this only while open, so a later change to
  // `initial` should NOT clobber what the user is typing. `untrack` states that intent (and
  // silences the state_referenced_locally advisory).
  let draft = $state<Draft>({ ...untrack(() => initial) });
  let errors = $state<Record<string, string>>({});
  let saving = $state(false);
  let saveError = $state('');

  function set(field: FieldDef, raw: string): void {
    draft[field.key] = coerceValue(field, raw);
    // Clear a field's error as soon as it is edited — stale red under a fixed field is noise.
    if (errors[field.key]) {
      const rest = { ...errors };
      delete rest[field.key];
      errors = rest;
    }
  }

  /** Controls are always fed a string; null renders as an empty control. */
  function display(key: string): string {
    const v = draft[key];
    return v === null || v === undefined ? '' : String(v);
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const found = validateDraft(fields, draft);
    errors = found;
    if (Object.keys(found).length > 0) return;

    saving = true;
    saveError = '';
    try {
      await onSave({ ...draft });
    } catch {
      // Surface the failure and stay open — never close on a write that did not land.
      saveError = 'Failed to save. Please try again.';
      saving = false;
    }
  }
</script>

<Modal open={true} {title} onClose={onCancel}>
  <form class="list-edit-form" onsubmit={submit}>
    {#each fields as field (field.key)}
      <label class="field">
        <span class="field-label">
          {field.label}
          {#if field.required}<span class="req" aria-hidden="true">*</span>{/if}
        </span>

        {#if field.type === 'textarea'}
          <textarea
            class="control textarea"
            class:invalid={!!errors[field.key]}
            rows="4"
            placeholder={field.placeholder}
            disabled={saving}
            value={display(field.key)}
            oninput={(e) => set(field, e.currentTarget.value)}
          ></textarea>
        {:else if field.type === 'select'}
          <select
            class="control select"
            class:invalid={!!errors[field.key]}
            disabled={saving}
            value={display(field.key)}
            onchange={(e) => set(field, e.currentTarget.value)}
          >
            <option value="">—</option>
            {#each field.options ?? [] as opt (opt)}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
        {:else}
          <input
            class="control input"
            class:invalid={!!errors[field.key]}
            type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
            placeholder={field.placeholder}
            disabled={saving}
            value={display(field.key)}
            oninput={(e) => set(field, e.currentTarget.value)}
          />
        {/if}

        {#if errors[field.key]}
          <span class="field-error">{errors[field.key]}</span>
        {:else if field.hint}
          <span class="field-hint">{field.hint}</span>
        {/if}
      </label>
    {/each}

    {#if saveError}
      <p class="save-error" role="alert">{saveError}</p>
    {/if}

    <div class="form-actions">
      <Button variant="ghost" onclick={onCancel} disabled={saving}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  </form>
</Modal>

<style lang="scss" src="./ListEditModal.scss"></style>
