<script lang="ts" generics="T extends ListItem">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import ListEditModal from './ListEditModal.svelte';
  import Modal from './Modal.svelte';
  import {
    cleanDraft,
    columnFields,
    defaultSearchKeys,
    defaultSortableKeys,
    emptyDraft,
    filterItems,
    formatValue,
    nextSort,
    sortItems,
    toDraft,
    type Draft,
    type FieldDef,
    type ListItem,
    type SortDir,
  } from './list-manager';

  // Generic CRUD list (PD-441). A user-managed list is a field array plus three handlers —
  // add/edit modal, filter-as-you-type and column sort all derive from the descriptors.
  // Pure logic lives in list-manager.ts so it is testable without mounting this.
  let {
    items,
    fields,
    getId,
    onCreate,
    onUpdate,
    onDelete,
    searchKeys,
    sortableKeys,
    title,
    addLabel = '+ Add',
    itemNoun = 'item',
    emptyText,
    searchPlaceholder = 'Filter…',
    row,
  }: {
    items: T[];
    fields: FieldDef[];
    getId: (item: T) => string | number;
    onCreate: (draft: Draft) => Promise<void> | void;
    onUpdate: (item: T, draft: Draft) => Promise<void> | void;
    onDelete: (item: T) => Promise<void> | void;
    searchKeys?: string[];
    sortableKeys?: string[];
    title?: string;
    addLabel?: string;
    itemNoun?: string;
    emptyText?: string;
    searchPlaceholder?: string;
    /** Custom row rendering for callers that want more than plain columns. */
    row?: Snippet<[T]>;
  } = $props();

  let query = $state('');
  let sort = $state<{ key: string | null; dir: SortDir }>({ key: null, dir: 'asc' });

  let editing = $state<T | null>(null);
  let adding = $state(false);
  let confirmingDelete = $state<T | null>(null);
  let deleting = $state(false);
  let deleteError = $state('');

  const cols = $derived(columnFields(fields));
  const keys = $derived(searchKeys ?? defaultSearchKeys(fields));
  const sortable = $derived(new Set(sortableKeys ?? defaultSortableKeys(fields)));

  const shown = $derived(sortItems(filterItems(items, query, keys), sort.key, sort.dir));
  const filtered = $derived(query.trim() !== '' && shown.length !== items.length);

  function toggleSort(key: string): void {
    if (!sortable.has(key)) return;
    sort = nextSort(sort, key);
  }

  function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    if (sort.key !== key) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  async function save(draft: Draft): Promise<void> {
    const clean = cleanDraft(draft);
    // Errors propagate to the modal, which stays open and shows the failure.
    if (editing) {
      await onUpdate(editing, clean);
    } else {
      await onCreate(clean);
    }
    editing = null;
    adding = false;
  }

  async function confirmDelete(): Promise<void> {
    if (!confirmingDelete) return;
    deleting = true;
    deleteError = '';
    try {
      await onDelete(confirmingDelete);
      confirmingDelete = null;
    } catch {
      deleteError = 'Failed to delete. Please try again.';
    } finally {
      deleting = false;
    }
  }
</script>

<div class="list-manager">
  <header class="lm-head">
    <div class="lm-head-left">
      {#if title}<h3 class="lm-title">{title}</h3>{/if}
      <span class="lm-count">
        {shown.length}
        {#if filtered}of {items.length}{/if}
        {itemNoun}{shown.length === 1 && !filtered ? '' : 's'}
      </span>
    </div>

    <div class="lm-head-right">
      <input
        class="lm-search"
        type="search"
        placeholder={searchPlaceholder}
        aria-label="Filter list"
        bind:value={query}
      />
      <Button variant="primary" onclick={() => (adding = true)}>{addLabel}</Button>
    </div>
  </header>

  {#if items.length === 0}
    <p class="lm-empty">{emptyText ?? `No ${itemNoun}s yet. Add one!`}</p>
  {:else if shown.length === 0}
    <p class="lm-empty">No {itemNoun}s match “{query}”.</p>
  {:else if row}
    <ul class="lm-rows">
      {#each shown as item (getId(item))}
        <li class="lm-row">
          <div class="lm-row-body">{@render row(item)}</div>
          <div class="lm-row-actions">
            <Button variant="ghost" onclick={() => (editing = item)}>Edit</Button>
            <Button variant="ghost" onclick={() => (confirmingDelete = item)}>Delete</Button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="lm-table-scroll">
      <table class="lm-table">
        <thead>
          <tr>
            {#each cols as col (col.key)}
              <th aria-sort={ariaSort(col.key)}>
                {#if sortable.has(col.key)}
                  <button class="lm-sort" type="button" onclick={() => toggleSort(col.key)}>
                    {col.label}
                    <span class="lm-sort-arrow" aria-hidden="true">
                      {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </button>
                {:else}
                  {col.label}
                {/if}
              </th>
            {/each}
            <th class="lm-actions-col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each shown as item (getId(item))}
            <tr>
              {#each cols as col (col.key)}
                <td class="lm-cell type-{col.type}">{formatValue(item[col.key])}</td>
              {/each}
              <td class="lm-cell lm-actions-cell">
                <Button variant="ghost" onclick={() => (editing = item)}>Edit</Button>
                <Button variant="ghost" onclick={() => (confirmingDelete = item)}>Delete</Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if adding || editing}
  <ListEditModal
    title={editing ? `Edit ${itemNoun}` : `New ${itemNoun}`}
    {fields}
    initial={editing ? toDraft(editing, fields) : emptyDraft(fields)}
    onSave={save}
    onCancel={() => {
      adding = false;
      editing = null;
    }}
  />
{/if}

{#if confirmingDelete}
  <Modal open={true} title={`Delete ${itemNoun}?`} onClose={() => (confirmingDelete = null)}>
    <div class="lm-confirm">
      <p class="lm-confirm-text">This cannot be undone.</p>
      {#if deleteError}<p class="lm-confirm-error" role="alert">{deleteError}</p>{/if}
      <div class="lm-confirm-actions">
        <Button variant="ghost" onclick={() => (confirmingDelete = null)} disabled={deleting}>
          Cancel
        </Button>
        <Button variant="primary" onclick={confirmDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </div>
  </Modal>
{/if}

<style lang="scss" src="./ListManager.scss"></style>
