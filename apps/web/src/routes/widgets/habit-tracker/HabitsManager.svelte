<script lang="ts">
  import {
    isValidTimezone,
    MINUTES_PER_DAY,
    scheduleForDay,
    scheduleLabel,
    type HabitItemView,
    type HabitSchedule,
    type HabitSettings,
    type SetHabitScheduleInput,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';
  import ScheduleEditor from './ScheduleEditor.svelte';
  import { toast } from '$lib/toast-store.svelte';

  /**
   * The Habits manage tab (PD-721; schedules PD-722; sets PD-723): add, rename, archive, delete and
   * re-nest habits and sets, edit a leaf's schedule, plus the two settings.
   *
   * The list is the item **tree** (a set is an item with children). Native HTML5 drag (D-069) both
   * reorders within a sibling group and moves an item into / out of a set: the drop zone within a row
   * decides — its top edge drops the item *before* the row (same parent), its bottom edge *after* it,
   * and its middle *into* it (nesting). Schedules belong to leaf habits only, so the schedule pill is
   * hidden on a set. Archiving a set archives its whole subtree, behind a confirm (D-095 for the
   * schedule-from-today rule).
   */
  let {
    items,
    schedules,
    today,
    settings,
    onAdd,
    onRename,
    onArchive,
    onDelete,
    onMove,
    onSchedule,
    onSettings,
  }: {
    items: HabitItemView[];
    schedules: HabitSchedule[];
    today: string;
    settings: HabitSettings;
    onAdd: (name: string) => Promise<void>;
    onRename: (id: number, name: string) => Promise<void>;
    onArchive: (id: number, archived: boolean) => Promise<void>;
    onDelete: (id: number) => Promise<void>;
    onMove: (itemId: number, parentId: number | null, siblingIds: number[]) => Promise<void>;
    onSchedule: (id: number, input: SetHabitScheduleInput) => Promise<void>;
    onSettings: (patch: Partial<HabitSettings>) => Promise<void>;
  } = $props();

  const active = $derived(items.filter((i) => i.archivedAt === null));
  const archived = $derived(items.filter((i) => i.archivedAt !== null));

  // Active children of a parent (null = top level), in stored sibling order.
  const childrenOf = (parentId: number | null): HabitItemView[] =>
    active.filter((i) => i.parentId === parentId);
  const childIds = (parentId: number | null): number[] => childrenOf(parentId).map((i) => i.id);
  // A set is an item with at least one active child.
  const setIds = $derived(new Set(active.filter((i) => i.parentId !== null).map((i) => i.parentId)));
  const isSet = (id: number): boolean => setIds.has(id);
  const roots = $derived(childrenOf(null));

  // The schedule in force today for a leaf, for the summary label and the editor's initial state.
  const currentSchedule = (itemId: number): HabitSchedule | null =>
    scheduleForDay(
      schedules.filter((s) => s.itemId === itemId),
      today,
    );

  // ── Schedule editor ──────────────────────────────────────────────────────────────
  let scheduleTarget = $state<HabitItemView | null>(null);

  async function saveSchedule(input: SetHabitScheduleInput) {
    const target = scheduleTarget;
    if (!target) return;
    try {
      await onSchedule(target.id, input);
    } catch {
      toast.show('Could not save the schedule.', 'error');
    }
  }

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

  // ── Archive (sets confirm first — the whole subtree goes) ────────────────────────
  let archiveTarget = $state<HabitItemView | null>(null);

  function subtreeSize(id: number): number {
    return childrenOf(id).reduce((n, c) => n + 1 + subtreeSize(c.id), 0);
  }

  async function doArchive(id: number, archived: boolean) {
    try {
      await onArchive(id, archived);
    } catch {
      toast.show('Could not update that habit.', 'error');
    }
  }

  function requestArchive(item: HabitItemView) {
    if (isSet(item.id)) archiveTarget = item; // confirm — the subtree goes with it
    else void doArchive(item.id, true);
  }

  async function confirmArchive() {
    const target = archiveTarget;
    archiveTarget = null;
    if (target) await doArchive(target.id, true);
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

  // ── Drag: reorder, nest and un-nest (native D-069) ───────────────────────────────
  type DropMode = 'before' | 'after' | 'into';
  let dragId = $state<number | null>(null);
  let dropTargetId = $state<number | null>(null);
  let dropMode = $state<DropMode>('into');

  function onDragOver(item: HabitItemView, e: DragEvent) {
    e.preventDefault();
    if (dragId === null || dragId === item.id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
    dropMode = frac < 0.25 ? 'before' : frac > 0.75 ? 'after' : 'into';
    dropTargetId = item.id;
  }

  function resetDrag() {
    dragId = null;
    dropTargetId = null;
  }

  async function onDrop(target: HabitItemView, e: DragEvent) {
    e.preventDefault();
    const from = dragId;
    const mode = dropMode;
    resetDrag();
    if (from === null || from === target.id) return;

    try {
      if (mode === 'into') {
        // Nest `from` under `target`, appended to its children.
        await onMove(from, target.id, [...childIds(target.id).filter((id) => id !== from), from]);
      } else {
        // Reorder within `target`'s sibling group, inserting before/after `target`.
        const parentId = target.parentId;
        const sibs = childIds(parentId).filter((id) => id !== from);
        const idx = sibs.indexOf(target.id);
        sibs.splice(mode === 'before' ? idx : idx + 1, 0, from);
        await onMove(from, parentId, sibs);
      }
    } catch {
      toast.show('Could not move that item.', 'error');
    }
  }

  async function onDropToTop(e: DragEvent) {
    e.preventDefault();
    const from = dragId;
    resetDrag();
    if (from === null) return;
    try {
      await onMove(from, null, [...childIds(null).filter((id) => id !== from), from]);
    } catch {
      toast.show('Could not move that item.', 'error');
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
      placeholder="New habit or set"
      aria-label="New habit name"
      bind:value={newName}
      maxlength="200"
    />
    <Button variant="primary" type="submit" disabled={newName.trim() === ''}>Add</Button>
  </form>
  <p class="hint">Drag a habit onto another to make a set; drag it out to the top to leave the set.</p>

  {#snippet row(item: HabitItemView)}
    {@const itemIsSet = isSet(item.id)}
    <li
      class="item-row"
      class:drop-into={dropTargetId === item.id && dropMode === 'into'}
      class:drop-before={dropTargetId === item.id && dropMode === 'before'}
      class:drop-after={dropTargetId === item.id && dropMode === 'after'}
      class:dragging={dragId === item.id}
      class:is-set={itemIsSet}
      draggable="true"
      ondragstart={() => (dragId = item.id)}
      ondragover={(e) => onDragOver(item, e)}
      ondrop={(e) => onDrop(item, e)}
      ondragend={resetDrag}
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
        <button type="button" class="item-name" onclick={() => startEdit(item)}>
          {#if itemIsSet}<span class="set-tag" aria-hidden="true">▦</span>{/if}{item.name}
        </button>
      {/if}
      {#if !itemIsSet}
        <button type="button" class="schedule-pill" onclick={() => (scheduleTarget = item)}>
          {scheduleLabel(currentSchedule(item.id))}
        </button>
      {/if}
      <div class="item-actions">
        <button type="button" class="link" onclick={() => requestArchive(item)}>Archive</button>
        <button type="button" class="link danger" onclick={() => (deleteTarget = item)}>Delete</button>
      </div>
    </li>
    {#if childrenOf(item.id).length > 0}
      <ul class="item-list children">
        {#each childrenOf(item.id) as child (child.id)}
          {@render row(child)}
        {/each}
      </ul>
    {/if}
  {/snippet}

  <ul class="item-list" aria-label="Habits">
    {#each roots as item (item.id)}
      {@render row(item)}
    {/each}
    {#if roots.length === 0}
      <li class="empty">No habits yet. Add one above.</li>
    {/if}
  </ul>

  <!-- Drop here to pull an item out of its set, back to the top level. -->
  <div
    class="unnest-zone"
    class:active={dragId !== null}
    role="presentation"
    ondragover={(e) => e.preventDefault()}
    ondrop={onDropToTop}
  >
    Drop here to move out of a set
  </div>

  {#if archived.length > 0}
    <section class="archived" aria-label="Archived habits">
      <h3>Archived</h3>
      <ul class="item-list">
        {#each archived as item (item.id)}
          <li class="item-row archived-row">
            <span class="item-name muted">{item.name}</span>
            <div class="item-actions">
              <button type="button" class="link" onclick={() => doArchive(item.id, false)}>Unarchive</button>
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

<Modal open={deleteTarget !== null} title="Delete habit?" onClose={() => (deleteTarget = null)}>
  {#if deleteTarget}
    {@const nested = subtreeSize(deleteTarget.id)}
    <p>
      Delete <strong>{deleteTarget.name}</strong> and its {deleteTarget.completionCount}
      {deleteTarget.completionCount === 1 ? 'completion' : 'completions'}{#if nested > 0}, plus its
        {nested} nested {nested === 1 ? 'item' : 'items'}{/if}?
    </p>
    <div class="modal-actions">
      <Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
      <Button variant="primary" accent onclick={confirmDelete}>Delete</Button>
    </div>
  {/if}
</Modal>

<Modal open={archiveTarget !== null} title="Archive set?" onClose={() => (archiveTarget = null)}>
  {#if archiveTarget}
    {@const nested = subtreeSize(archiveTarget.id)}
    <p>
      Archive <strong>{archiveTarget.name}</strong> and its {nested} nested
      {nested === 1 ? 'item' : 'items'}? History is kept.
    </p>
    <div class="modal-actions">
      <Button variant="ghost" onclick={() => (archiveTarget = null)}>Cancel</Button>
      <Button variant="primary" onclick={confirmArchive}>Archive</Button>
    </div>
  {/if}
</Modal>

{#if scheduleTarget}
  <ScheduleEditor
    name={scheduleTarget.name}
    schedule={currentSchedule(scheduleTarget.id)}
    onSave={saveSchedule}
    onClose={() => (scheduleTarget = null)}
  />
{/if}

<style lang="scss" src="./HabitsManager.scss"></style>
