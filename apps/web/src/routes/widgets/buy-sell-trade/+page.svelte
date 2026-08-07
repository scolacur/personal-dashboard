<script lang="ts">
  import { onMount } from 'svelte';
  import {
    BST_CATEGORIES,
    BST_LISTING_TYPES,
    BST_SALE_STATUSES,
    type BstImportResult,
    type BstDraftFormat,
    type BstListing,
    type BstMatch,
    type UpdateBstListingInput,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import Modal from '$lib/Modal.svelte';
  import type { Draft, FieldDef } from '$lib/list-manager';
  import {
    BstDuplicateError,
    createListing,
    deleteListing,
    fetchListings,
    fetchMatches,
    fetchSettings,
    importCsv,
    saveTerms,
    updateListing,
  } from '$lib/buy-sell-trade/api';
  import DraftsPanel from './DraftsPanel.svelte';
  import GearTables from './GearTables.svelte';
  import MatchesReadout from './MatchesReadout.svelte';
  import ScanStatus from './ScanStatus.svelte';
  import SaleTerms from './SaleTerms.svelte';

  // Buy/Sell/Trade expanded view (PD-437, matches PD-438). The gear list is the shared input
  // for the epic's two jobs: the weekly r/modular scan matches against it and the monthly
  // drafter renders from it (PD-439). Management is the generic ListManager (PD-441) configured
  // with the list's columns — no bespoke list here.

  let listings = $state<BstListing[]>([]);
  let matches = $state<BstMatch[]>([]);
  let terms = $state('');
  let templates = $state<Record<BstDraftFormat, string>>({} as Record<BstDraftFormat, string>);
  let loading = $state(true);
  let loadError = $state('');
  let moveError = $state('');

  /**
   * A pending "you already have one of these — add another?" question. Duplicates are legal
   * (Steve owns two of some items at different prices), so the server asks instead of refusing.
   * The promise is resolved by the modal's buttons, which lets `onCreate` simply await the
   * answer and carry on — the edit modal underneath stays open the whole time.
   */
  let dupPrompt = $state<{
    message: string;
    existing: BstListing[];
    resolve: (confirmed: boolean) => void;
  } | null>(null);

  function askDuplicate(e: BstDuplicateError): Promise<boolean> {
    return new Promise((resolve) => {
      dupPrompt = { message: e.message, existing: e.existing, resolve };
    });
  }

  function answerDuplicate(confirmed: boolean): void {
    dupPrompt?.resolve(confirmed);
    dupPrompt = null;
  }

  let termsSaving = $state(false);
  let termsError = $state('');

  let csv = $state('');
  let importing = $state(false);
  let importError = $state('');
  let importResult = $state<BstImportResult | null>(null);

  const FIELDS: FieldDef[] = [
    // Segmented rather than a dropdown: two values that are the whole meaning of the row, so
    // showing both beats hiding them behind a click. Kept in the modal even though the column
    // is hidden — this is the accessible alternative to dragging a row between tables.
    { key: 'type', label: 'Type', type: 'segmented', options: BST_LISTING_TYPES, required: true },
    { key: 'manufacturer', label: 'Maker', type: 'text', placeholder: 'e.g. Make Noise' },
    { key: 'item', label: 'Item', type: 'text', required: true, placeholder: 'e.g. Maths' },
    // Price is free text on purpose: "$250 shipped" / "offers" / "trade only" are all real.
    { key: 'price', label: 'Price', type: 'text', placeholder: 'e.g. $250 shipped' },
    { key: 'condition', label: 'Condition', type: 'text', placeholder: 'e.g. Mint' },
    {
      key: 'saleStatus',
      label: 'Sale status',
      type: 'select',
      options: BST_SALE_STATUSES,
      hint: 'Only “for-sale” is drafted as a firm sale',
    },
    { key: 'category', label: 'Category', type: 'select', options: BST_CATEGORIES },
    {
      key: 'aliases',
      label: 'Also known as',
      type: 'text',
      placeholder: 'e.g. A-111-5, mini synth voice',
      hint: 'Comma-separated. What people call it in a thread — the scan matches these too.',
    },
    {
      key: 'notes',
      label: 'Public notes',
      type: 'textarea',
      formOnly: true,
      hint: 'Goes in the post — “og box”, “purchased new”',
    },
    {
      key: 'privateNotes',
      label: 'Private notes',
      type: 'textarea',
      formOnly: true,
      hint: 'Yours only — never posted',
    },
    {
      key: 'location',
      label: 'Location',
      type: 'text',
      hint: 'Yours only — shown when drafting so you can find it',
    },
  ];

  async function load(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      const [l, s, m] = await Promise.all([fetchListings(), fetchSettings(), fetchMatches()]);
      listings = l;
      terms = s.terms;
      templates = s.templates;
      matches = m;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  // ListManager awaits these and keeps its modal open on a throw, so errors must propagate.
  async function onCreate(draft: Draft): Promise<void> {
    try {
      await createListing(draft as never);
    } catch (e) {
      if (!(e instanceof BstDuplicateError)) throw e;
      if (!(await askDuplicate(e))) throw new Error('Not added — you already have this listed.');
      await createListing(draft as never, true);
    }
    listings = await fetchListings();
  }

  async function onUpdate(item: BstListing, draft: Draft): Promise<void> {
    // A cleared field arrives as absent from the clean draft; send an explicit null so the
    // server clears it rather than treating it as "unchanged".
    const patch: Record<string, unknown> = { ...draft };
    for (const f of FIELDS) if (!(f.key in patch)) patch[f.key] = null;
    try {
      await updateListing(item.id, patch as never);
    } catch (e) {
      if (!(e instanceof BstDuplicateError)) throw e;
      if (!(await askDuplicate(e))) throw new Error('Not saved — that duplicates another listing.');
      await updateListing(item.id, patch as never, true);
    }
    listings = await fetchListings();
  }

  async function onDelete(item: BstListing): Promise<void> {
    await deleteListing(item.id);
    listings = await fetchListings();
  }

  /**
   * A row was dragged into another status table. `confirmDuplicate` is sent up front, unlike
   * create and edit: a move does not change what the listing *is*, so a duplicate warning here
   * would be asking about a clash the drag did not create — and there is no modal open to ask in.
   */
  async function onMove(listing: BstListing, patch: UpdateBstListingInput): Promise<void> {
    moveError = '';
    try {
      await updateListing(listing.id, patch as never, true);
      listings = await fetchListings();
    } catch (e) {
      moveError = e instanceof Error ? e.message : 'Failed to move that listing';
    }
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

  /**
   * Adopt the terms the importer found in the sheet. **Saves rather than just filling the box**:
   * the editor is now a fixed panel that seeds its draft when opened, so setting the value
   * without persisting it would show Steve terms that are not actually stored anywhere.
   */
  async function adoptExtractedTerms(): Promise<void> {
    const found = importResult?.extractedTerms;
    if (!found) return;
    termsSaving = true;
    termsError = '';
    try {
      terms = (await saveTerms(found)).terms;
    } catch (e) {
      termsError = e instanceof Error ? e.message : 'Failed to save terms';
    } finally {
      termsSaving = false;
    }
  }

  const counts = $derived({
    WTS: listings.filter((l) => l.type === 'WTS').length,
    WTB: listings.filter((l) => l.type === 'WTB').length,
  });

</script>

<section class="bst-page">
  <header class="bst-head">
    <h1 class="bst-title">Buy, Sell, Trade</h1>
    <!-- States what actually runs, and says plainly what does not yet (PD-475 E). A subhead that
         describes an aspiration is worse than one honest about its own status; the note is cheap
         to delete once the jobs register, and PD-476 replaces it with a readout derived from the
         real registration rather than retyped here. -->
    <p class="bst-sub">
      Every <strong>Monday</strong>, a job scans the r/modular monthly Buy/Sell/Trade thread and
      looks for matches with items on my list. On the <strong>15th</strong> of each month, it
      drafts for-sale posts formatted for Reddit, Discord and Facebook.
    </p>
    <p class="bst-sub bst-sub-caveat">
      <strong>Neither job is scheduled yet.</strong> The scan needs Reddit API approval
      (PD-471) and the monthly drafter has no cron registered (PD-439) — but the drafter itself
      works: “Generate now” under Drafted posts renders all three formats from the current list.
    </p>
  </header>

  {#if loading}
    <p class="bst-loading">Loading…</p>
  {:else if loadError}
    <p class="bst-error" role="alert">{loadError}</p>
  {:else}
    <div class="bst-counts">
      <span class="count-pill type-wts">{counts.WTS} for sale</span>
      <span class="count-pill type-wtb">{counts.WTB} wanted</span>
      {#if matches.length > 0}
        <span class="count-pill type-match">{matches.length} new match{matches.length === 1 ? '' : 'es'}</span>
      {/if}
    </div>

    <ScanStatus onMatchesChanged={async () => (matches = await fetchMatches())} />

    {#if matches.length > 0}
      <MatchesReadout
        {matches}
        onDismissed={(id) => (matches = matches.filter((m) => m.id !== id))}
      />
    {/if}

    {#if moveError}<p class="bst-error" role="alert">{moveError}</p>{/if}

    <GearTables listings={listings} fields={FIELDS} {onCreate} {onUpdate} {onDelete} {onMove} />

    <DraftsPanel
      {listings}
      {templates}
      onTemplatesSaved={(t) => (templates = t)}
    />

    <Collapsible title="Import from CSV" storeKey="bst-import">
      <div class="bst-import">
        <p class="bst-import-help">
          Export the sheet as CSV and paste it here. Matching is on
          <strong>type + maker + item + condition</strong>, so re-pasting corrects rows instead of
          duplicating them — and two of the same thing in different condition stay two rows.
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

            {#if importResult.extractedTerms}
              <!-- Offered, never auto-applied: a re-import must not clobber terms edited here. -->
              <div class="bst-found-terms">
                <p class="bst-found-terms-head">Sale terms found in the sheet:</p>
                <pre class="bst-found-terms-body">{importResult.extractedTerms}</pre>
                {#if termsError}<p class="bst-error" role="alert">{termsError}</p>{/if}
                <Button variant="ghost" onclick={adoptExtractedTerms} disabled={termsSaving}>
                  {termsSaving ? 'Saving…' : 'Use these terms'}
                </Button>
              </div>
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

  {/if}
</section>

{#if !loading && !loadError}
  <!-- Out of the page flow: fixed to the bottom, collapsed, expanding upward. The page reserves
       its collapsed height (see .bst-page) so it never covers the last row of a gear table. -->
  <SaleTerms bind:terms />
{/if}

{#if dupPrompt}
  <!-- Layered over ListManager's edit modal, which stays open behind it: answering resolves the
       promise `onCreate`/`onUpdate` is awaiting, so the save simply continues or aborts. -->
  <Modal open={true} title="Already on your list" onClose={() => answerDuplicate(false)}>
    <div class="bst-dup">
      <p class="bst-dup-text">{dupPrompt.message}</p>
      <ul class="bst-dup-list">
        {#each dupPrompt.existing as e (e.id)}
          <li>
            <strong>{e.item}</strong>
            {#if e.condition}<span class="bst-dup-detail">{e.condition}</span>{/if}
            {#if e.price}<span class="bst-dup-detail">{e.price}</span>{/if}
          </li>
        {/each}
      </ul>
      <div class="bst-dup-actions">
        <Button variant="ghost" onclick={() => answerDuplicate(false)}>Cancel</Button>
        <Button variant="primary" onclick={() => answerDuplicate(true)}>Add anyway</Button>
      </div>
    </div>
  </Modal>
{/if}

<style lang="scss" src="./+page.scss"></style>
