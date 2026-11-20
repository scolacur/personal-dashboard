<script lang="ts">
  import { type HabitChoiceOption, type HabitItemView, type HabitMetricType } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';
  import { toast } from '$lib/toast-store.svelte';
  import { RejectedError } from './api';

  /**
   * Edit a metric (PD-724): its type and, for a choice metric, its options. A metric's **type cannot
   * change once it has a value** — the server enforces that (it holds the values), so a change that is
   * refused surfaces as a message rather than being pre-disabled here.
   *
   * Option edits (add / rename / archive / delete) go straight through the callbacks, which refresh
   * Today so the multi-select there reflects the new option set. Archiving keeps an option in history
   * while removing it from new picks; deleting removes it (past values keep its id).
   */
  let {
    item,
    onMetricType,
    onListOptions,
    onAddOption,
    onEditOption,
    onArchiveOption,
    onDeleteOption,
    onClose,
  }: {
    item: HabitItemView;
    onMetricType: (id: number, metricType: HabitMetricType) => Promise<void>;
    onListOptions: (id: number) => Promise<HabitChoiceOption[]>;
    onAddOption: (id: number, label: string) => Promise<HabitChoiceOption>;
    onEditOption: (optionId: number, label: string) => Promise<HabitChoiceOption>;
    onArchiveOption: (optionId: number, archived: boolean) => Promise<HabitChoiceOption>;
    onDeleteOption: (optionId: number) => Promise<void>;
    onClose: () => void;
  } = $props();

  const TYPES: HabitMetricType[] = ['time', 'number', 'choice'];
  // The last type the server accepted — the source of truth for which editor to show.
  let currentType = $state<HabitMetricType>(item.metricType ?? 'number');

  let options = $state<HabitChoiceOption[]>([]);
  let newOption = $state('');
  let editingId = $state<number | null>(null);
  let editingLabel = $state('');

  async function refreshOptions() {
    if (currentType !== 'choice') return;
    try {
      options = await onListOptions(item.id);
    } catch {
      toast.show('Could not load options.', 'error');
    }
  }

  $effect(() => {
    void refreshOptions();
  });

  async function changeType(type: HabitMetricType) {
    if (type === currentType) return;
    const previous = currentType;
    currentType = type; // optimistic, reverted on refusal
    try {
      await onMetricType(item.id, type);
      await refreshOptions();
    } catch (e) {
      currentType = previous;
      toast.show(
        e instanceof RejectedError
          ? "This metric already has values, so its type can't change."
          : 'Could not change the metric type.',
        'error',
        6000,
      );
    }
  }

  async function addOption(e: Event) {
    e.preventDefault();
    const label = newOption.trim();
    if (!label) return;
    try {
      await onAddOption(item.id, label);
      newOption = '';
      await refreshOptions();
    } catch {
      toast.show('Could not add that option.', 'error');
    }
  }

  function startEdit(option: HabitChoiceOption) {
    editingId = option.id;
    editingLabel = option.label;
  }

  async function commitEdit(option: HabitChoiceOption) {
    const label = editingLabel.trim();
    editingId = null;
    if (!label || label === option.label) return;
    try {
      await onEditOption(option.id, label);
      await refreshOptions();
    } catch {
      toast.show('Could not rename that option.', 'error');
    }
  }

  async function toggleArchive(option: HabitChoiceOption) {
    try {
      await onArchiveOption(option.id, option.archivedAt === null);
      await refreshOptions();
    } catch {
      toast.show('Could not update that option.', 'error');
    }
  }

  async function remove(option: HabitChoiceOption) {
    try {
      await onDeleteOption(option.id);
      await refreshOptions();
    } catch {
      toast.show('Could not delete that option.', 'error');
    }
  }
</script>

<Modal open title={`Metric — ${item.name}`} onClose={onClose}>
  <div class="metric-editor">
    <div class="type-toggle" role="group" aria-label="Metric type">
      {#each TYPES as type (type)}
        <button type="button" class:active={currentType === type} onclick={() => changeType(type)}>
          {type}
        </button>
      {/each}
    </div>
    <p class="hint">A metric's type can't change once it has a logged value.</p>

    {#if currentType === 'choice'}
      <section class="options" aria-label="Choice options">
        <h4>Options</h4>
        <ul class="option-list">
          {#each options as option (option.id)}
            <li class="option-row" class:archived={option.archivedAt !== null}>
              {#if editingId === option.id}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="option-input"
                  type="text"
                  aria-label="Rename option"
                  bind:value={editingLabel}
                  maxlength="100"
                  autofocus
                  onblur={() => commitEdit(option)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitEdit(option);
                    else if (e.key === 'Escape') editingId = null;
                  }}
                />
              {:else}
                <button type="button" class="option-label" onclick={() => startEdit(option)}>
                  {option.label}{#if option.archivedAt !== null}<span class="tag"> (archived)</span>{/if}
                </button>
              {/if}
              <div class="option-actions">
                <button type="button" class="link" onclick={() => toggleArchive(option)}>
                  {option.archivedAt === null ? 'Archive' : 'Restore'}
                </button>
                <button type="button" class="link danger" onclick={() => remove(option)}>Delete</button>
              </div>
            </li>
          {/each}
          {#if options.length === 0}
            <li class="empty">No options yet.</li>
          {/if}
        </ul>
        <form class="add-option" onsubmit={addOption}>
          <input type="text" placeholder="New option" aria-label="New option" bind:value={newOption} maxlength="100" />
          <Button variant="primary" type="submit" disabled={newOption.trim() === ''}>Add</Button>
        </form>
      </section>
    {/if}

    <div class="modal-actions">
      <Button variant="ghost" onclick={onClose}>Done</Button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./MetricEditor.scss"></style>
