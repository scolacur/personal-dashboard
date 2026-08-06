<script lang="ts" generics="T extends ListItem">
  import { untrack, type Snippet } from 'svelte';
  import { Trash2 } from 'lucide-svelte';
  import Button from './Button.svelte';
  import ListEditModal from './ListEditModal.svelte';
  import Modal from './Modal.svelte';
  import { readOpen, writeOpen } from './collapse-store';
  import {
    cleanDraft,
    countLabel,
    defaultSearchKeys,
    defaultSortableKeys,
    emptyDraft,
    filterItems,
    formatValue,
    nextSort,
    readField,
    searchScopeLabel,
    sortItems,
    toDraft,
    visibleColumns,
    type CountStyle,
    type Draft,
    type FieldDef,
    type ListItem,
    type SortDir,
  } from './list-manager';

  // Generic CRUD list (PD-441). A user-managed list is a field array plus three handlers —
  // add/edit modal, filter-as-you-type and column sort all derive from the descriptors.
  // Pure logic lives in list-manager.ts so it is testable without mounting this.
  //
  // PD-475 added the drag/collapse primitives. They are deliberately **mechanically neutral**:
  // this component knows a row can be dragged and that something was dropped on it, and nothing
  // about what either means. The caller decides — see the BST page, which runs four instances and
  // maps a drop onto a sale-status change. That split exists because this component has exactly
  // one consumer today, and an API designed against one imagined caller is how `ListItem =
  // Record<string, unknown>` shipped unusable.
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
    searchPlaceholder = 'Filter',
    hiddenKeys,
    countStyle = 'noun',
    collapsible = false,
    storeKey,
    dragType,
    onDropItem,
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
    /** Columns to leave out. Still editable in the modal and still searched — see
     *  `visibleColumns`. */
    hiddenKeys?: string[];
    countStyle?: CountStyle;
    /** Header toggles the body. The controls stay clickable — they are siblings of the toggle,
     *  not children, because nesting a button inside a button is invalid HTML. */
    collapsible?: boolean;
    /** Persist the collapsed state under this key. */
    storeKey?: string;
    /**
     * Makes rows draggable, and this list a drop target, using `dataTransfer` under this key.
     *
     * Sibling instances sharing a key can exchange rows with **no shared state** — the browser
     * carries the id between them. That is what makes several independent lists viable instead
     * of one list with a `groups` prop.
     */
    dragType?: string;
    /** A row from a list sharing this `dragType` was dropped here. Receives the raw id string,
     *  since `dataTransfer` only carries text. */
    onDropItem?: (id: string) => Promise<void> | void;
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

  // Seeded once from storage — see Collapsible, same reasoning: a re-render must not reopen a
  // table the user closed.
  let open = $state(untrack(() => readOpen(storeKey, true)));
  let dragOver = $state(false);

  const cols = $derived(visibleColumns(fields, hiddenKeys));
  const keys = $derived(searchKeys ?? defaultSearchKeys(fields));
  const sortable = $derived(new Set(sortableKeys ?? defaultSortableKeys(fields)));

  const shown = $derived(sortItems(filterItems(items, query, keys), sort.key, sort.dir));
  const count = $derived(countLabel(shown.length, items.length, itemNoun, countStyle));

  function toggleOpen(): void {
    open = !open;
    writeOpen(storeKey, open);
  }

  function toggleSort(key: string): void {
    if (!sortable.has(key)) return;
    sort = nextSort(sort, key);
  }

  function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    if (sort.key !== key) return 'none';
    return sort.dir === 'asc' ? 'ascending' : 'descending';
  }

  /* ── Drag and drop ────────────────────────────── */

  function startDrag(e: DragEvent, item: T): void {
    if (!dragType || !e.dataTransfer) return;
    e.dataTransfer.setData(dragType, String(getId(item)));
    e.dataTransfer.effectAllowed = 'move';
  }

  /** Only react to a drag carrying our own kind of payload — otherwise dragging a file or a
   *  selection over the page lights every list up. */
  function accepts(e: DragEvent): boolean {
    return !!dragType && !!onDropItem && !!e.dataTransfer?.types.includes(dragType);
  }

  function over(e: DragEvent): void {
    if (!accepts(e)) return;
    // Without preventDefault the browser refuses the drop entirely — this is the opt-in.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOver = true;
  }

  async function drop(e: DragEvent): Promise<void> {
    if (!accepts(e)) return;
    e.preventDefault();
    dragOver = false;
    const id = e.dataTransfer?.getData(dragType!);
    if (id) await onDropItem?.(id);
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

{#snippet rowActions(item: T)}
  <Button variant="ghost" onclick={() => (editing = item)}>Edit</Button>
  <Button
    variant="icon"
    title="Delete"
    aria-label="Delete"
    onclick={() => (confirmingDelete = item)}
  >
    <Trash2 size={13} />
  </Button>
{/snippet}

<!-- The drop target is the whole component, not just the rows: a collapsed list and an empty
     list both have to accept a row, and neither has any rows to aim at. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="list-manager"
  class:collapsed={!open}
  class:drag-over={dragOver}
  ondragover={over}
  ondragleave={() => (dragOver = false)}
  ondrop={drop}
>
  <header class="lm-head">
    <div class="lm-head-left">
      {#if collapsible}
        <button class="lm-toggle" type="button" aria-expanded={open} onclick={toggleOpen}>
          <span class="lm-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          {#if title}<span class="lm-title">{title}</span>{/if}
          <span class="lm-count">{count}</span>
        </button>
      {:else}
        {#if title}<h3 class="lm-title">{title}</h3>{/if}
        <span class="lm-count">{count}</span>
      {/if}
    </div>

    {#if open}
      <div class="lm-head-right">
        <input
          class="lm-search"
          type="search"
          placeholder={searchPlaceholder}
          title={searchScopeLabel(fields, keys)}
          aria-label="Filter list"
          bind:value={query}
        />
        <Button variant="primary" onclick={() => (adding = true)}>{addLabel}</Button>
      </div>
    {/if}
  </header>

  {#if open}
    {#if items.length === 0}
      <p class="lm-empty">{emptyText ?? `No ${itemNoun}s yet. Add one!`}</p>
    {:else if shown.length === 0}
      <p class="lm-empty">No {itemNoun}s match “{query}”.</p>
    {:else if row}
      <ul class="lm-rows">
        {#each shown as item (getId(item))}
          <li
            class="lm-row"
            draggable={!!dragType}
            ondragstart={(e) => startDrag(e, item)}
          >
            <div class="lm-row-body">{@render row(item)}</div>
            <div class="lm-row-actions">{@render rowActions(item)}</div>
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
              <tr draggable={!!dragType} ondragstart={(e) => startDrag(e, item)}>
                {#each cols as col (col.key)}
                  <td class="lm-cell type-{col.type}">{formatValue(readField(item, col.key))}</td>
                {/each}
                <td class="lm-cell lm-actions-cell">{@render rowActions(item)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
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
