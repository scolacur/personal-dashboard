<script lang="ts">
  import { onMount } from 'svelte';
  import type { BstListing, JobRun } from '@dashboard/shared';
  import { BST_SCAN_JOB } from '@dashboard/shared';
  import { fetchListings, fetchOpenMatchCount } from './buy-sell-trade/api';
  import { fetchJobRuns } from './job-runs-api';
  import { relativeTime, runStatusLabel } from './job-runs-display';

  // Collapsed summary card for the Buy/Sell/Trade widget (PD-437, matches PD-438). Per D-062
  // the card header links to the widget page rather than flipping, so this face is read-only:
  // counts by type, new matches from the weekly scan, and a hint of what is listed.
  let { variant = 'widget' }: { variant?: 'widget' | 'page' } = $props();

  let listings = $state<BstListing[]>([]);
  let openMatches = $state(0);
  let lastScan = $state<JobRun | null>(null);
  let loading = $state(true);
  let failed = $state(false);

  onMount(async () => {
    try {
      // A count endpoint rather than the match list: this renders on the dashboard grid
      // alongside every other widget and has no business pulling the whole table.
      const [l, m] = await Promise.all([fetchListings(), fetchOpenMatchCount()]);
      listings = l;
      openMatches = m;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }

    // Separate and non-blocking (PD-440). "0 new matches" is ambiguous between a quiet week and a
    // scanner that stopped a month ago, and this line is what separates them — but it is a
    // footnote, so it must never be the reason the card fails to render.
    try {
      lastScan = (await fetchJobRuns(BST_SCAN_JOB, 1))[0] ?? null;
    } catch {
      lastScan = null;
    }
  });

  const counts = $derived({
    WTS: listings.filter((l) => l.type === 'WTS').length,
    WTB: listings.filter((l) => l.type === 'WTB').length,
  });

  /** A few item names so the card says something concrete rather than only numbers. */
  const preview = $derived(
    listings
      .filter((l) => l.type === 'WTS')
      .slice(0, 4)
      .map((l) => l.item),
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
        <span class="stat-n">{counts.WTB}</span>
        <span class="stat-l">wanted</span>
      </span>
      <span class="stat" class:has-matches={openMatches > 0}>
        <span class="stat-n">{openMatches}</span>
        <span class="stat-l">new match{openMatches === 1 ? '' : 'es'}</span>
      </span>
    </div>
    {#if preview.length > 0}
      <p class="bst-card-preview">{preview.join(' · ')}{listings.length > preview.length ? ' …' : ''}</p>
    {/if}
    {#if lastScan}
      <p class="bst-card-scanned" class:not-clean={lastScan.status !== 'ok'}>
        Last scanned {relativeTime(lastScan.startedAt)}{lastScan.status === 'ok'
          ? ''
          : ` · ${runStatusLabel(lastScan.status)}`}
      </p>
    {/if}
  {/if}
</div>

<style lang="scss" src="./BuySellTrade.scss"></style>
