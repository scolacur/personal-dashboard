<script lang="ts">
  import type { BstListing, UpdateBstListingInput } from '@dashboard/shared';
  import ListManager from '$lib/ListManager.svelte';
  import type { Draft, FieldDef } from '$lib/list-manager';
  import {
    createDefaults,
    groupIntoTables,
    movePatch,
    type GearTable,
  } from '$lib/buy-sell-trade/gear-tables';

  // The gear list as four collapsible tables in willingness order (PD-475 B). The ordering, the
  // labels, the hidden columns and what a drop means all live on this side — `ListManager` only
  // knows that rows are draggable and that something was dropped. See gear-tables.ts for why.
  let {
    listings,
    fields,
    onCreate,
    onUpdate,
    onDelete,
    onMove,
  }: {
    listings: BstListing[];
    fields: FieldDef[];
    onCreate: (draft: Draft) => Promise<void>;
    onUpdate: (item: BstListing, draft: Draft) => Promise<void>;
    onDelete: (item: BstListing) => Promise<void>;
    onMove: (listing: BstListing, patch: UpdateBstListingInput) => Promise<void>;
  } = $props();

  /**
   * The `dataTransfer` key the four tables speak to each other with.
   *
   * Cross-instance drag needs **no shared state** — the browser carries the id from the table
   * the row left to the one it landed on, which is what makes four independent `ListManager`s
   * viable instead of one component that knows about groups. Namespaced so a drag from some
   * other list on some other page cannot land here.
   */
  const DRAG_TYPE = 'application/x-bst-listing';

  /**
   * The type and sale-status **columns** are hidden because the table a row sits in already says
   * both — repeating them on every row is noise.
   *
   * The **fields** stay in the edit modal, and that is what makes the accessible path free:
   * "open the row, change the dropdown" is a complete alternative to dragging, so there is no
   * separate move menu to build. A drag-only affordance would not have been acceptable.
   */
  const HIDDEN = ['type', 'saleStatus'];

  const groups = $derived(groupIntoTables(listings));

  async function handleDrop(table: GearTable, rawId: string): Promise<void> {
    const listing = listings.find((l) => String(l.id) === rawId);
    if (!listing) return;
    const patch = movePatch(listing, table);
    // Null means it was dropped back where it started — not a write.
    if (patch) await onMove(listing, patch);
  }
</script>

<div class="gear-tables">
  {#each groups as { table, items } (table.key)}
    <ListManager
      items={items}
      {fields}
      getId={(l) => l.id}
      title={table.label}
      itemNoun="listing"
      addLabel="+ Add"
      countStyle="parens"
      hiddenKeys={HIDDEN}
      collapsible
      storeKey={`bst-gear-${table.key}`}
      dragType={DRAG_TYPE}
      emptyText={table.emptyText}
      onDropItem={(id) => handleDrop(table, id)}
      onCreate={(draft) => onCreate({ ...createDefaults(table), ...draft })}
      {onUpdate}
      {onDelete}
    />
  {/each}
</div>

<style lang="scss" src="./GearTables.scss"></style>
