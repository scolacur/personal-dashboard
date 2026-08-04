<script lang="ts">
  import { onMount } from 'svelte';
  import { BST_LISTING_TYPES, type BstImportResult, type BstListing } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import ListManager from '$lib/ListManager.svelte';
  import type { Draft, FieldDef } from '$lib/list-manager';
  import {
    createListing,
    deleteListing,
    fetchListings,
    fetchSettings,
    importCsv,
    saveTerms,
    updateListing,
  } from '$lib/buy-sell-trade/api';

  // Buy/Sell/Trade expanded view (PD-437). The gear list is the shared input for the epic's
  // two jobs: the weekly r/modular scan matches against it (PD-438) and the monthly drafter
  // renders from it (PD-439). Management is the generic ListManager (PD-441) configured with
  // the sheet's columns — no bespoke list here.

  let listings = $state<BstListing[]>([]);
  let terms = $state('');
  let savedTerms = $state('');
  let loading = $state(true);
  let loadError = $state('');

  let termsSaving = $state(false);
  let termsError = $state('');
  const termsDirty = $derived(terms !== savedTerms);

  let csv = $state('');
  let importing = $state(false);
  let importError = $state('');
  let importResult = $state<BstImportResult | null>(null);

  const FIELDS: FieldDef[] = [
    { key: 'type', label: 'Type', type: 'select', options: BST_LISTING_TYPES, required: true },
    { key: 'manufacturer', label: 'Manufacturer', type: 'text', placeholder: 'e.g. Make Noise' },
    { key: 'module', label: 'Module', type: 'text', required: true, placeholder: 'e.g. Maths' },
    // Price is free text on purpose: "$250 shipped" / "offers" / "trade only" are all real.
    { key: 'price', label: 'Price', type: 'text', placeholder: 'e.g. $250 shipped' },
    { key: 'condition', label: 'Condition', type: 'text', placeholder: 'e.g. Mint' },
    { key: 'location', label: 'Location', type: 'text', hint: 'Your own reference — never posted' },
    { key: 'notes', label: 'Notes', type: 'textarea', formOnly: true },
  ];

  async function load(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      const [l, s] = await Promise.all([fetchListings(), fetchSettings()]);
      listings = l;
      terms = s.terms;
      savedTerms = s.terms;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ListManager awaits these and keeps its modal open on a throw, so errors must propagate.
  async function onCreate(draft: Draft): Promise<void> {
    await createListing(draft as never);
    listings = await fetchListings();
  }

  async function onUpdate(item: BstListing, draft: Draft): Promise<void> {
    // A cleared field arrives as absent from the clean draft; send an explicit null so the
    // server clears it rather than treating it as "unchanged".
    const patch: Record<string, unknown> = { ...draft };
    for (const f of FIELDS) if (!(f.key in patch)) patch[f.key] = null;
    await updateListing(item.id, patch as never);
    listings = await fetchListings();
  }

  async function onDelete(item: BstListing): Promise<void> {
    await deleteListing(item.id);
    listings = await fetchListings();
  }

  async function runImport(): Promise<void> {
    if (!csv.trim()) return;
    importing = true;
    importError = '';
    importResult = null;
    try {
      importResult = await importCsv(csv);
      listings = await fetchListings();
      if (importResult.skipped === 0) csv = '';
    } catch (e) {
      importError = e instanceof Error ? e.message : 'Import failed';
    } finally {
      importing = false;
    }
  }

  async function persistTerms(): Promise<void> {
    termsSaving = true;
    termsError = '';
    try {
      const s = await saveTerms(terms);
      savedTerms = s.terms;
    } catch (e) {
      termsError = e instanceof Error ? e.message : 'Failed to save terms';
    } finally {
      termsSaving = false;
    }
  }

  const counts = $derived({
    WTS: listings.filter((l) => l.type === 'WTS').length,
    WTB: listings.filter((l) => l.type === 'WTB').length,
    WTT: listings.filter((l) => l.type === 'WTT').length,
  });
</script>

<section class="bst-page">
  <header class="bst-head">
    <h1 class="bst-title">Buy, Sell, Trade</h1>
    <p class="bst-sub">
      Your WTB / WTS / WTT list and standing sale terms. The weekly r/modular scan matches
      against this list, and the monthly drafter posts from it.
    </p>
  </header>

  {#if loading}
    <p class="bst-loading">Loading…</p>
  {:else if loadError}
    <p class="bst-error" role="alert">{loadError}</p>
  {:else}
    <div class="bst-counts">
      <span class="count-pill type-wts">{counts.WTS} for sale</span>
      <span class="count-pill type-wtt">{counts.WTT} for trade</span>
      <span class="count-pill type-wtb">{counts.WTB} wanted</span>
    </div>

    <ListManager
      items={listings}
      fields={FIELDS}
      getId={(l) => l.id}
      {onCreate}
      {onUpdate}
      {onDelete}
      title="Gear list"
      itemNoun="listing"
      addLabel="+ Add listing"
      searchPlaceholder="Filter by module, maker, notes…"
      emptyText="No listings yet — add one, or import your sheet below."
    />

    <Collapsible title="Import from CSV" storeKey="bst-import">
      <div class="bst-import">
        <p class="bst-import-help">
          Export the sheet as CSV and paste it here. Matching is on
          <strong>type + manufacturer + module</strong>, so re-pasting corrects rows instead of
          duplicating them.
        </p>
        <textarea
          class="bst-csv"
          rows="8"
          bind:value={csv}
          disabled={importing}
          placeholder="Type,Manufacturer,Module,Price,Condition,Notes,Current Location&#10;WTS,Make Noise,Maths,$250,Mint,boxed,Rack A"
        ></textarea>

        {#if importError}
          <p class="bst-error" role="alert">{importError}</p>
        {/if}

        {#if importResult}
          <div class="bst-import-result" role="status">
            <p>
              <strong>{importResult.created}</strong> added ·
              <strong>{importResult.updated}</strong> updated ·
              <strong>{importResult.skipped}</strong> skipped
            </p>
            {#if importResult.problems.length > 0}
              <ul class="bst-problems">
                {#each importResult.problems as p (p)}
                  <li>{p}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}

        <div class="bst-import-actions">
          <Button variant="primary" onclick={runImport} disabled={importing || !csv.trim()}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </div>
    </Collapsible>

    <Collapsible title="Sale terms" storeKey="bst-terms">
      <div class="bst-terms">
        <p class="bst-terms-help">
          Appended to every drafted post. Changes rarely — shipping, payment, packing.
        </p>
        <textarea class="bst-terms-input" rows="8" bind:value={terms} disabled={termsSaving}></textarea>
        {#if termsError}
          <p class="bst-error" role="alert">{termsError}</p>
        {/if}
        <div class="bst-terms-actions">
          {#if termsDirty}<span class="bst-unsaved">Unsaved changes</span>{/if}
          <Button variant="primary" onclick={persistTerms} disabled={termsSaving || !termsDirty}>
            {termsSaving ? 'Saving…' : 'Save terms'}
          </Button>
        </div>
      </div>
    </Collapsible>
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
