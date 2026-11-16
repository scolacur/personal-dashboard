<script lang="ts">
  import {
    isValidTimezone,
    MINUTES_PER_DAY,
    type HabitItemView,
    type HabitSettings,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';
  import { toast } from '$lib/toast-store.svelte';

  /**
   * The Habits manage tab (PD-721): add, rename, archive, delete and reorder habits, plus the two
   * settings. Reorder is native HTML5 drag (D-069). Delete confirms with the completion count the
   * list already carries ("Delete Gym and its 84 completions?").
   */
  let {
    items,
    settings,
    onAdd,
    onRename,
    onArchive,
    onDelete,
    onReorder,
    onSettings,
  }: {
    items: HabitItemView[];
    settings: HabitSettings;
    onAdd: (name: string) => Promise<void>;
    onRename: (id: number, name: string) => Promise<void>;
    onArchive: (id: number, archived: boolean) => Promise<void>;
    onDelete: (id: number) => Promise<void>;
    onReorder: (ids: number[]) => Promise<void>;
    onSettings: (patch: Partial<HabitSettings>) => Promise<void>;
  } = $props();

  const active = $derived(items.filter((i) => i.archivedAt === null));
  const archived = $derived(items.filter((i) => i.archivedAt !== null));

  // ── Add ────────────────────────────────────────────────────────────────────────
  let newName = $state('');
  async function submitAdd(e: Event) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await onAdd(name);
      newName = '';
    } catch {
      toast.show('Could not add that habit.', 'error');
    }
  }

  // ── Inline rename ────────────────────────────────────────────────────────────────
  let editingId = $state<number | null>(null);
  let editingName = $state('');

  function startEdit(item: HabitItemView) {
    editingId = item.id;
    editingName = item.name;
  }

  async function commitEdit(item: HabitItemView) {
    const name = editingName.trim();
    editingId = null;
    if (!name || name === item.name) return;
    try {
      await onRename(item.id, name);
    } catch {
      toast.show('Could not rename that habit.', 'error');
    }
  }

  async function toggleArchive(item: HabitItemView) {
    try {
      await onArchive(item.id, item.archivedAt === null);
    } catch {
      toast.show('Could not update that habit.', 'error');
    }
  }

  // ── Delete (confirm with count) ─────────────────────────────────────────────────
  let deleteTarget = $state<HabitItemView | null>(null);

  async function confirmDelete() {
    const target = deleteTarget;
    deleteTarget = null;
    if (!target) return;
    try {
      await onDelete(target.id);
    } catch {
      toast.show('Could not delete that habit.', 'error');
    }
  }

  // ── Reorder (native drag, active items only) ────────────────────────────────────
  let dragId = $state<number | null>(null);
  let dropTargetId = $state<number | null>(null);

  function onDragOver(id: number, e: DragEvent) {
    e.preventDefault();
    if (dragId !== null && dragId !== id) dropTargetId = id;
  }

  async function onDrop(id: number, e: DragEvent) {
    e.preventDefault();
    const from = dragId;
    dragId = null;
    dropTargetId = null;
    if (from === null || from === id) return;

    const order = active.map((i) => i.id);
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(id);
    if (fromIdx === -1 || toIdx === -1) return;
    order.splice(toIdx, 0, ...order.splice(fromIdx, 1));

    // Send every id so sort_order stays contiguous; archived ids keep their place after the active.
    try {
      await onReorder([...order, ...archived.map((i) => i.id)]);
    } catch {
      toast.show('Could not reorder.', 'error');
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────────────
  function minutesToTime(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  async function onBoundaryChange(e: Event) {
    const value = (e.currentTarget as HTMLInputElement).value;
    const [h, m] = value.split(':').map(Number);
    const minutes = h * 60 + m;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return;
    try {
      await onSettings({ dayBoundaryMinutes: minutes });
    } catch {
      toast.show('Could not save the day boundary.', 'error');
    }
  }

  // Writable derived: tracks the stored timezone, but editable in place until committed/reverted.
  let tzDraft = $derived(settings.timezone);

  async function onTimezoneCommit() {
    const tz = tzDraft.trim();
    if (tz === settings.timezone) return;
    if (!isValidTimezone(tz)) {
      toast.show('That is not a recognised timezone.', 'error');
      tzDraft = settings.timezone;
      return;
    }
    try {
      await onSettings({ timezone: tz });
    } catch {
      toast.show('Could not save the timezone.', 'error');
    }
  }
</script>

<div class="habits-manager">
  <form class="add-form" onsubmit={submitAdd}>
    <input
      type="text"
      placeholder="New habit"
      aria-label="New habit name"
      bind:value={newName}
      maxlength="200"
    />
    <Button variant="primary" type="submit" disabled={newName.trim() === ''}>Add</Button>
  </form>

  <ul class="item-list" aria-label="Habits">
    {#each active as item (item.id)}
      <li
        class="item-row"
        class:drop-target={dropTargetId === item.id}
        class:dragging={dragId === item.id}
        draggable="true"
        ondragstart={() => (dragId = item.id)}
        ondragover={(e) => onDragOver(item.id, e)}
        ondrop={(e) => onDrop(item.id, e)}
        ondragend={() => {
          dragId = null;
          dropTargetId = null;
        }}
      >
        <span class="grip" aria-hidden="true">⋮⋮</span>
        {#if editingId === item.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="rename-input"
            type="text"
            aria-label="Rename habit"
            bind:value={editingName}
            maxlength="200"
            autofocus
            onblur={() => commitEdit(item)}
            onkeydown={(e) => {
              if (e.key === 'Enter') commitEdit(item);
              else if (e.key === 'Escape') editingId = null;
            }}
          />
        {:else}
          <button type="button" class="item-name" onclick={() => startEdit(item)}>{item.name}</button>
        {/if}
        <div class="item-actions">
          <button type="button" class="link" onclick={() => toggleArchive(item)}>Archive</button>
          <button type="button" class="link danger" onclick={() => (deleteTarget = item)}>Delete</button>
        </div>
      </li>
    {/each}
    {#if active.length === 0}
      <li class="empty">No habits yet. Add one above.</li>
    {/if}
  </ul>

  {#if archived.length > 0}
    <section class="archived" aria-label="Archived habits">
      <h3>Archived</h3>
      <ul class="item-list">
        {#each archived as item (item.id)}
          <li class="item-row archived-row">
            <span class="item-name muted">{item.name}</span>
            <div class="item-actions">
              <button type="button" class="link" onclick={() => toggleArchive(item)}>Unarchive</button>
              <button type="button" class="link danger" onclick={() => (deleteTarget = item)}>Delete</button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="settings" aria-label="Settings">
    <h3>Settings</h3>
    <label>
      <span>Day starts at</span>
      <input type="time" value={minutesToTime(settings.dayBoundaryMinutes)} onchange={onBoundaryChange} />
    </label>
    <label>
      <span>Home timezone</span>
      <input
        type="text"
        bind:value={tzDraft}
        onblur={onTimezoneCommit}
        onkeydown={(e) => e.key === 'Enter' && onTimezoneCommit()}
        aria-label="Home timezone"
      />
    </label>
  </section>
</div>

<Modal
  open={deleteTarget !== null}
  title="Delete habit?"
  onClose={() => (deleteTarget = null)}
>
  {#if deleteTarget}
    <p>
      Delete <strong>{deleteTarget.name}</strong> and its {deleteTarget.completionCount}
      {deleteTarget.completionCount === 1 ? 'completion' : 'completions'}?
    </p>
    <div class="modal-actions">
      <Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="primary" accent onclick={confirmDelete}>Delete</Button>
    </div>
  {/if}
</Modal>

<style lang="scss" src="./HabitsManager.scss"></style>
