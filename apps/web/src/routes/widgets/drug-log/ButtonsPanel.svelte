<script lang="ts">
  import type { DrugLogDrug } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import DrugButtons from './DrugButtons.svelte';
  import DrugEditModal from './DrugEditModal.svelte';
  import { createDrug, deleteDrug, updateDrug } from './api';
  import { activeDrugs, archivedDrugs, moveDrug } from './drug-log';

  /**
   * The page's Buttons tab (PD-975, Drug log widget): the tap grid, plus an edit mode that adds,
   * edits, reorders, archives and deletes buttons and lists archived ones to bring back.
   * Managing buttons needs the server; only taps are offline-safe.
   */
  interface Props {
    drugs: DrugLogDrug[];
    counts: Map<number, number>;
    onTap: (drug: DrugLogDrug) => void;
    /** Replace the parent's drug list after a change here. */
    onDrugsChange: (drugs: DrugLogDrug[]) => void;
  }

  let { drugs, counts, onTap, onDrugsChange }: Props = $props();

  let editing = $state(false);
  let modalOpen = $state(false);
  let editingId = $state<number | null>(null);

  const active = $derived(activeDrugs(drugs));
  const archived = $derived(archivedDrugs(drugs));
  const editingDrug = $derived(
    editingId === null ? null : (drugs.find((d) => d.id === editingId) ?? null),
  );
  const editIndex = $derived(editingDrug ? active.findIndex((d) => d.id === editingDrug.id) : -1);

  function replace(drug: DrugLogDrug): void {
    onDrugsChange(
      drugs.some((d) => d.id === drug.id)
        ? drugs.map((d) => (d.id === drug.id ? drug : d))
        : [...drugs, drug],
    );
  }

  function openAdd(): void {
    editingId = null;
    modalOpen = true;
  }

  function openEdit(drug: DrugLogDrug): void {
    editingId = drug.id;
    modalOpen = true;
  }

  function close(): void {
    modalOpen = false;
  }

  async function save(input: { label: string; color: string }): Promise<void> {
    replace(editingDrug ? await updateDrug(editingDrug.id, input) : await createDrug(input));
    close();
  }

  async function move(delta: -1 | 1): Promise<void> {
    if (!editingDrug) return;
    const patches = moveDrug(drugs, editingDrug.id, delta);
    const updated = await Promise.all(
      patches.map((p) => updateDrug(p.id, { sortOrder: p.sortOrder })),
    );
    const byId = new Map(updated.map((d) => [d.id, d]));
    onDrugsChange(drugs.map((d) => byId.get(d.id) ?? d));
  }

  async function archive(): Promise<void> {
    if (!editingDrug) return;
    replace(await updateDrug(editingDrug.id, { archived: true }));
    toast.show(`Archived ${editingDrug.label}`);
    close();
  }

  async function remove(): Promise<void> {
    if (!editingDrug) return;
    const { id, label } = editingDrug;
    await deleteDrug(id);
    onDrugsChange(drugs.filter((d) => d.id !== id));
    toast.show(`Deleted ${label}`);
    close();
  }

  async function unarchive(drug: DrugLogDrug): Promise<void> {
    try {
      replace(await updateDrug(drug.id, { archived: false }));
    } catch (e) {
      toast.show(`Couldn't restore ${drug.label}: ${(e as Error).message}`, 'error');
    }
  }
</script>

<div class="buttons-panel">
  <div class="toolbar">
    <button
      type="button"
      class="edit-toggle"
      aria-pressed={editing}
      onclick={() => (editing = !editing)}
    >
      {editing ? 'Done' : 'Edit'}
    </button>
  </div>

  {#if active.length === 0 && !editing}
    <p class="empty">No buttons yet. Tap Edit, then + to add one.</p>
  {:else}
    <DrugButtons drugs={active} {counts} {editing} {onTap} onEdit={openEdit} onAdd={openAdd} />
  {/if}

  {#if editing && archived.length > 0}
    <section class="archived" aria-label="Archived buttons">
      <h3>Archived</h3>
      <ul>
        {#each archived as drug (drug.id)}
          <li>
            <span class="dot" style:background={drug.color} aria-hidden="true"></span>
            <span class="name">{drug.label}</span>
            <span class="n">{drug.eventCount} {drug.eventCount === 1 ? 'entry' : 'entries'}</span>
            <button type="button" onclick={() => unarchive(drug)}>Unarchive</button>
            <button type="button" onclick={() => openEdit(drug)}>Edit</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <DrugEditModal
    open={modalOpen}
    drug={editingDrug}
    canMoveEarlier={editIndex > 0}
    canMoveLater={editIndex >= 0 && editIndex < active.length - 1}
    onClose={close}
    onSave={save}
    onMove={move}
    onArchive={editingDrug && editingDrug.archivedAt === null ? archive : undefined}
    onDelete={remove}
  />
</div>

<style lang="scss" src="./ButtonsPanel.scss"></style>
