<script lang="ts">
  import { onMount } from 'svelte';
  import {
    BST_CATEGORIES,
    BST_LISTING_TYPES,
    BST_MATCH_INTENT_LABELS,
    BST_SALE_STATUSES,
    matchSignificance,
    type BstImportResult,
    type BstListing,
    type BstMatch,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import ListManager from '$lib/ListManager.svelte';
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
    setMatchDismissed,
    updateListing,
  } from '$lib/buy-sell-trade/api';

  // Buy/Sell/Trade expanded view (PD-437, matches PD-438). The gear list is the shared input
  // for the epic's two jobs: the weekly r/modular scan matches against it and the monthly
  // drafter renders from it (PD-439). Management is the generic ListManager (PD-441) configured
  // with the list's columns — no bespoke list here.

  let listings = $state<BstListing[]>([]);
  let matches = $state<BstMatch[]>([]);
  let terms = $state('');
  let savedTerms = $state('');
  let loading = $state(true);
  let loadError = $state('');

  let matchBusy = $state<number | null>(null);
  let matchError = $state('');

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
  const termsDirty = $derived(terms !== savedTerms);

  let csv = $state('');
  let importing = $state(false);
  let importError = $state('');
  let importResult = $state<BstImportResult | null>(null);

  const FIELDS: FieldDef[] = [
    { key: 'type', label: 'Type', type: 'select', options: BST_LISTING_TYPES, required: true },
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
      savedTerms = s.terms;
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
  });

  async function dismiss(m: BstMatch): Promise<void> {
    matchBusy = m.id;
    matchError = '';
    try {
      await setMatchDismissed(m.id, true);
      matches = matches.filter((x) => x.id !== m.id);
    } catch (e) {
      matchError = e instanceof Error ? e.message : 'Failed to dismiss';
    } finally {
      matchBusy = null;
    }
  }

  /**
   * Grouped by item, because one comment can mention several things and one thing can be
   * mentioned by several people — and because duplicate listings for the same item would
   * otherwise show the same comment twice.
   *
   * Ordered by significance first: a stranger selling something on Steve's want list is the
   * payoff of the whole scan, and sorting purely by recency buries it under sale-side noise.
   */
  const grouped = $derived.by(() => {
    const rank = { high: 0, normal: 1, low: 2 } as const;
    // Null-prototype rather than `{}` so an item literally named "__proto__" is just a key,
    // and rather than a Map because the lint rule wants SvelteMap for anything reactive —
    // this is rebuilt from scratch on every change, so neither applies.
    const byItem = Object.create(null) as Record<string, BstMatch[]>;
    for (const m of matches) {
      const key = m.manufacturer ? `${m.manufacturer} ${m.item}` : m.item;
      (byItem[key] ??= []).push(m);
    }
    return Object.entries(byItem)
      .map(([label, items]) => ({
        label,
        items,
        significance: items
          .map((m) =>
            matchSignificance({ type: m.listingType, saleStatus: m.saleStatus }, m.intent),
          )
          .sort((a, b) => rank[a] - rank[b])[0],
      }))
      .sort((a, b) => rank[a.significance] - rank[b.significance] || a.label.localeCompare(b.label));
  });
</script>

<section class="bst-page">
  <header class="bst-head">
    <h1 class="bst-title">Buy, Sell, Trade</h1>
    <p class="bst-sub">
      Your gear list and standing sale terms. The weekly r/modular scan matches against this
      list, and the monthly drafter posts from it.
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

    {#if matches.length > 0}
      <section class="bst-matches" aria-label="Matches from r/modular">
        <h2 class="bst-matches-title">Matches from r/modular</h2>
        {#if matchError}<p class="bst-error" role="alert">{matchError}</p>{/if}

        {#each grouped as group (group.label)}
          <article class="match-group sig-{group.significance}">
            <h3 class="match-item">
              {group.label}
              {#if group.significance === 'high'}
                <span class="match-flag">worth a look</span>
              {/if}
            </h3>
            <ul class="match-list">
              {#each group.items as m (m.id)}
                <li class="match">
                  <div class="match-meta">
                    <span class="match-intent intent-{m.intent}">
                      {BST_MATCH_INTENT_LABELS[m.intent]}
                    </span>
                    <a class="match-author" href={m.authorUrl} target="_blank" rel="noreferrer noopener">
                      u/{m.author}
                    </a>
                  </div>
                  <p class="match-excerpt">{m.excerpt}</p>
                  <div class="match-actions">
                    <a class="match-link" href={m.permalink} target="_blank" rel="noreferrer noopener">
                      Open comment ↗
                    </a>
                    <Button variant="ghost" onclick={() => dismiss(m)} disabled={matchBusy === m.id}>
                      {matchBusy === m.id ? 'Dismissing…' : 'Dismiss'}
                    </Button>
                  </div>
                </li>
              {/each}
            </ul>
          </article>
        {/each}
      </section>
    {/if}

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
      searchPlaceholder="Filter by item, maker, notes…"
      emptyText="No listings yet — add one, or import your sheet below."
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
                <Button
                  variant="ghost"
                  onclick={() => {
                    terms = importResult?.extractedTerms ?? terms;
                  }}
                >
                  Use these terms
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
