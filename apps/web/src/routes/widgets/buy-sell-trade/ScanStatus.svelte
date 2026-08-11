<script lang="ts">
  import { onMount } from 'svelte';
  import type { BstScan } from '@dashboard/shared';
  import { fetchScans } from '$lib/buy-sell-trade/api';

  // The r/modular scan's status (PD-471).
  //
  // **This component exists to be loud.** The matches readout below it shows what was found; the
  // danger is that "found nothing" and "could not look" render identically, so a scan that has
  // been quietly failing for a month looks like a quiet month. Everything here is arranged so
  // that a degraded scan is impossible to mistake for a clean one:
  //
  //   - the status leads, before any count;
  //   - `failed` and `partial` are alerts, with the reason, not a subtle badge;
  //   - a stale successful scan is itself a warning — a cron that silently stopped shows up as
  //     "last scanned 23 days ago" rather than as nothing at all.
  //
  // The **button** lives in the page header now, not here — this is the readout, and the action
  // sits with the page's other top-level actions. The page owns the in-flight state and bumps
  // `refresh` when a scan finishes, which is this component's cue to re-read its history.
  let {
    busy = false,
    refresh = 0,
  }: {
    /** A scan is running (started from the page header). */
    busy?: boolean;
    /** Changes when a scan completes — re-reads the scan history. */
    refresh?: number;
  } = $props();

  let scans = $state<BstScan[]>([]);
  let loadError = $state('');

  const latest = $derived(scans[0] ?? null);
  const found = $derived(
    latest ? latest.threads.reduce((n, t) => n + t.created, 0) : 0,
  );

  /** The scan is meant to run weekly; past this it is either broken or nobody is running it. */
  const STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
  const stale = $derived(
    latest !== null && latest.status === 'ok' && Date.now() - latest.startedAt > STALE_AFTER_MS,
  );

  function when(at: number): string {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    const stamp = new Date(at).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    if (days === 0) return `today, ${new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' })}`;
    return `${stamp} (${days} day${days === 1 ? '' : 's'} ago)`;
  }

  async function load(): Promise<void> {
    loadError = '';
    try {
      scans = await fetchScans();
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Could not load scan history';
    }
  }

  onMount(load);

  // Re-read after the page's scan finishes. `refresh` starts at 0 and the effect runs once on
  // mount alongside onMount's load — harmless, and cheaper than tracking "have I loaded yet".
  let seen = 0;
  $effect(() => {
    if (refresh !== seen) {
      seen = refresh;
      load();
    }
  });
</script>

<section class="scan" aria-label="r/modular scan status">
  <div class="scan-bar">
    {#if busy}
      <!-- Measured at ~140s for three requests. Saying so is the difference between "working"
           and "hung" — the pacing is deliberate (see DEFAULT_REQUEST_GAP_MS), not a stall. -->
      <span class="scan-when">
        Scanning r/modular — takes about two minutes, Reddit’s public feed allows roughly one
        request a minute.
      </span>
    {:else if latest}
      <span class="scan-when">Last scan {when(latest.startedAt)}</span>
    {:else}
      <span class="scan-when">Never scanned</span>
    {/if}
  </div>

  {#if loadError}
    <p class="scan-alert failed" role="alert">{loadError}</p>
  {/if}

  {#if latest}
    {#if latest.status === 'failed'}
      <div class="scan-alert failed" role="alert">
        <strong>The last scan failed — it saw nothing.</strong>
        <p class="scan-reason">{latest.error ?? 'No reason recorded.'}</p>
        <p class="scan-note">
          This is not “no offers this week”. Reddit’s public feed is rate limited to about one
          request a minute and can start refusing without notice; the matches below are from
          whenever the scan last worked.
        </p>
      </div>
    {:else if latest.status === 'partial'}
      <div class="scan-alert partial" role="alert">
        <strong>The last scan only partly completed — some offers may be missing.</strong>
        <ul class="scan-threads">
          {#each latest.threads as t (t.url)}
            <li>
              <a href={t.url} target="_blank" rel="noreferrer noopener">{t.title}</a>
              {#if t.error}
                <span class="thread-error">{t.error}</span>
              {:else}
                <span class="thread-ok">{t.scanned} comments read</span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {:else if stale}
      <div class="scan-alert partial" role="alert">
        <strong>The last successful scan was {when(latest.startedAt)}.</strong>
        <p class="scan-note">It is meant to run weekly — nothing has run it since.</p>
      </div>
    {:else}
      <p class="scan-ok">
        Read {latest.threads.reduce((n, t) => n + t.scanned, 0)} comments across
        {latest.threads.length} thread{latest.threads.length === 1 ? '' : 's'} ·
        {found} new match{found === 1 ? '' : 'es'}
      </p>
    {/if}
  {/if}
</section>

<style lang="scss" src="./ScanStatus.scss"></style>
