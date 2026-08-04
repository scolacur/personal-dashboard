<script lang="ts">
  import { onMount } from 'svelte';
  import type { BstListing } from '@dashboard/shared';
  import { fetchListings } from './buy-sell-trade/api';

  // Collapsed summary card for the Buy/Sell/Trade widget (PD-437). Per D-062 the card header
  // links to the widget page rather than flipping, so this face is read-only: counts by type,
  // and a hint of what is listed. Matches readout arrives with the scan job (PD-438).
  let { variant = 'widget' }: { variant?: 'widget' | 'page' } = $props();

  let listings = $state<BstListing[]>([]);
  let loading = $state(true);
  let failed = $state(false);

  onMount(async () => {
    try {
      listings = await fetchListings();
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });

  const counts = $derived({
    WTS: listings.filter((l) => l.type === 'WTS').length,
    WTT: listings.filter((l) => l.type === 'WTT').length,
    WTB: listings.filter((l) => l.type === 'WTB').length,
  });

  /** A few module names so the card says something concrete rather than only numbers. */
  const preview = $derived(
    listings
      .filter((l) => l.type !== 'WTB')
      .slice(0, 4)
      .map((l) => l.module),
  );
</script>

<div class="bst-card" class:page={variant === 'page'}>
  {#if loading}
    <p class="bst-card-muted">Loading…</p>
  {:else if failed}
    <p class="bst-card-muted">Couldn’t load the list.</p>
  {:else if listings.length === 0}
    <p class="bst-card-muted">No listings yet.</p>
  {:else}
    <div class="bst-card-counts">
      <span class="stat">
        <span class="stat-n">{counts.WTS}</span>
        <span class="stat-l">for sale</span>
      </span>
      <span class="stat">
        <span class="stat-n">{counts.WTT}</span>
        <span class="stat-l">for trade</span>
      </span>
      <span class="stat">
        <span class="stat-n">{counts.WTB}</span>
        <span class="stat-l">wanted</span>
      </span>
    </div>
    {#if preview.length > 0}
      <p class="bst-card-preview">{preview.join(' · ')}{listings.length > preview.length ? ' …' : ''}</p>
    {/if}
  {/if}
</div>

<style lang="scss" src="./BuySellTrade.scss"></style>
