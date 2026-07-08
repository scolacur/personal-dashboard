<script lang="ts">
  import { onMount } from 'svelte';
  import type { Track } from '@dashboard/shared';
  import { fetchTracks, createTrack } from './api';

  let tracks = $state<Track[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  // Form state
  let artist = $state('');
  let title = $state('');
  let remixer = $state('');
  let notes = $state('');
  let wantMusicLibrary = $state(true);
  let wantDjLibrary = $state(true);
  let saving = $state(false);
  let formError = $state('');

  const canSubmit = $derived(artist.trim().length > 0 && title.trim().length > 0);

  onMount(async () => {
    try {
      tracks = await fetchTracks();
    } catch {
      loadError = 'Failed to load tracks.';
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    saving = true;
    formError = '';
    try {
      const created = await createTrack({
        artist,
        title,
        remixer: remixer.trim() || undefined,
        notes: notes.trim() || undefined,
        wantMusicLibrary,
        wantDjLibrary,
      });
      tracks = [created, ...tracks];
      // Reset the entry fields; keep the library defaults as-is.
      artist = '';
      title = '';
      remixer = '';
      notes = '';
    } catch {
      formError = 'Could not save that track. Try again.';
    } finally {
      saving = false;
    }
  }

  function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
</script>

<div class="mt-page">
  <header class="page-header">
    <h1 class="page-title">Music Tracker</h1>
  </header>

  <form class="add-form" onsubmit={handleSubmit}>
    <div class="field-row">
      <div class="field">
        <label class="field-label" for="artist">Artist</label>
        <input id="artist" class="text-input" type="text" bind:value={artist} placeholder="Artist" />
      </div>
      <div class="field">
        <label class="field-label" for="title">Title</label>
        <input id="title" class="text-input" type="text" bind:value={title} placeholder="Title" />
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="remixer">Remixer / mix <span class="optional">(optional)</span></label>
      <input id="remixer" class="text-input" type="text" bind:value={remixer} placeholder="e.g. Extended Mix" />
    </div>

    <div class="field">
      <label class="field-label" for="notes">Notes <span class="optional">(optional)</span></label>
      <textarea id="notes" class="text-input" rows="2" bind:value={notes} placeholder="Anything to remember"></textarea>
    </div>

    <fieldset class="targets">
      <legend class="field-label">Add to</legend>
      <label class="checkbox">
        <input type="checkbox" bind:checked={wantMusicLibrary} />
        Music Library
      </label>
      <label class="checkbox">
        <input type="checkbox" bind:checked={wantDjLibrary} />
        DJ Library
      </label>
    </fieldset>

    {#if formError}
      <p class="status-msg error">{formError}</p>
    {/if}

    <button class="submit-btn" type="submit" disabled={!canSubmit || saving}>
      {saving ? 'Adding…' : 'Add track'}
    </button>
  </form>

  <section class="tracks">
    <h2 class="tracks-heading">
      Tracked {#if !loading && !loadError}<span class="count">({tracks.length})</span>{/if}
    </h2>

    {#if loading}
      <p class="status-msg">Loading…</p>
    {:else if loadError}
      <p class="status-msg error">{loadError}</p>
    {:else if tracks.length === 0}
      <p class="status-msg">No tracks yet. Add one above.</p>
    {:else}
      <ul class="track-list">
        {#each tracks as track (track.id)}
          <li class="track">
            <div class="track-main">
              <span class="track-title">
                {track.rawArtist} — {track.rawTitle}{#if track.rawRemixer} <span class="remixer">({track.rawRemixer})</span>{/if}
              </span>
              {#if track.rawNotes}<span class="track-notes">{track.rawNotes}</span>{/if}
            </div>
            <div class="track-meta">
              <span class="status-pill">{track.status.replace('_', ' ')}</span>
              {#if track.wantMusicLibrary}<span class="lib-chip">Music</span>{/if}
              {#if track.wantDjLibrary}<span class="lib-chip">DJ</span>{/if}
              <span class="track-date">{formatDate(track.detectedAt)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style lang="scss" src="./+page.scss"></style>
