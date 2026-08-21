<script lang="ts">
  import { onMount } from 'svelte';
  import { cueLink, formatPosition, mixMatchesQuery, type Cue, type Mix } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import {
    createCue,
    createMix,
    deleteCue,
    DuplicateMixError,
    fetchMixes,
    resolveRename,
    setArchived,
    syncNow,
    updateCue,
  } from '../routes/widgets/id-tracker/api';

  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();

  let mixes = $state<Mix[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let syncing = $state(false);
  let syncMessage = $state('');
  let configured = $state(true);
  let showArchived = $state(false);

  // Which mix's IDs section is open. Mix-centric by design: IDs are entered while listening to
  // one mix, so they live under it rather than in a cross-mix queue.
  let expanded = $state<number | null>(null);
  let addingTo = $state<number | null>(null);
  let renameFor = $state<Mix | null>(null);

  // Add-ID form
  let position = $state('');
  let artist = $state('');
  let title = $state('');
  let remixer = $state('');
  let notes = $state('');
  let cueError = $state('');
  let cueWarning = $state('');
  let savingCue = $state(false);

  // Add-mix form (page only) — for mixes that are not on YouTube, including ones with no URL.
  let newMixTitle = $state('');
  let newMixUrl = $state('');
  let mixError = $state('');
  let confirmCreate = $state(false);

  const openIdCount = $derived(
    mixes.reduce((n, m) => n + m.cues.filter((c) => !c.identified).length, 0),
  );

  /**
   * Mixes already tracked under a name like the one being typed.
   *
   * Token containment rather than a plain substring, so "dekmantel 25" still finds
   * "Nina Kraviz | Dekmantel Festival 2025" — the near-miss spelling is exactly the case a
   * duplicate check has to catch, and a substring match misses it.
   */
  const similarMixes = $derived(
    mixes.filter((m) => mixMatchesQuery(m.title, newMixTitle)).slice(0, 5),
  );
  const visibleMixes = $derived(variant === 'widget' ? mixes.filter((m) => m.cues.length > 0).slice(0, 4) : mixes);

  async function load() {
    try {
      const res = await fetchMixes(showArchived);
      mixes = res.mixes;
      syncing = res.syncing;
      configured = res.configured;
    } catch {
      loadError = 'Failed to load mixes.';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function handleSync() {
    syncing = true;
    syncMessage = '';
    try {
      const { summary, mixes: fresh } = await syncNow();
      mixes = fresh;
      syncMessage =
        summary.created === 0 && summary.retitled === 0
          ? 'Up to date.'
          : `${summary.created} new, ${summary.retitled} retitled.`;
    } catch (e) {
      syncMessage = e instanceof Error ? e.message : 'Sync failed.';
    } finally {
      syncing = false;
    }
  }

  function startAdd(mixId: number) {
    addingTo = mixId;
    expanded = mixId;
    position = '';
    artist = '';
    title = '';
    remixer = '';
    notes = '';
    cueError = '';
    cueWarning = '';
  }

  async function submitCue(mix: Mix) {
    if (savingCue || !position.trim()) return;
    savingCue = true;
    cueError = '';
    cueWarning = '';
    try {
      const { cue, warnings } = await createCue(mix.id, { position, artist, title, remixer, notes });
      mixes = mixes.map((m) =>
        m.id === mix.id ? { ...m, cues: [...m.cues, cue].sort((a, b) => a.positionS - b.positionS) } : m,
      );
      cueWarning = warnings[0] ?? '';
      // Clear the fields but keep the form open — logging several IDs in a row is the workflow.
      position = '';
      artist = '';
      title = '';
      remixer = '';
      notes = '';
    } catch (e) {
      cueError = e instanceof Error ? e.message : 'Could not save that ID.';
    } finally {
      savingCue = false;
    }
  }

  async function identify(cue: Cue, field: 'artist' | 'title', value: string) {
    const { cue: updated } = await updateCue(cue.id, { [field]: value });
    mixes = mixes.map((m) => ({
      ...m,
      cues: m.cues.map((c) => (c.id === updated.id ? updated : c)),
    }));
  }

  async function removeCue(mixId: number, cueId: number) {
    await deleteCue(cueId);
    mixes = mixes.map((m) => (m.id === mixId ? { ...m, cues: m.cues.filter((c) => c.id !== cueId) } : m));
  }

  async function toggleArchive(mix: Mix) {
    const archiving = mix.archivedAt === null;
    if (archiving && mix.cues.length > 0) {
      const ok = confirm(`Archive "${mix.title}" and its ${mix.cues.length} ID${mix.cues.length === 1 ? '' : 's'}?`);
      if (!ok) return;
    }
    const updated = await setArchived(mix.id, archiving);
    mixes = showArchived
      ? mixes.map((m) => (m.id === updated.id ? updated : m))
      : mixes.filter((m) => m.id !== updated.id);
  }

  async function handleRename(mix: Mix, accept: boolean) {
    const updated = await resolveRename(mix.id, accept);
    mixes = mixes.map((m) => (m.id === updated.id ? updated : m));
    renameFor = null;
  }

  async function submitMix(force = false) {
    const name = newMixTitle.trim();
    if (!name) {
      mixError = 'A mix needs a name.';
      return;
    }
    // Explicit confirm before creating: silent creation is how "Dekmantel 2025" and
    // "Dekmantel 25" both end up holding IDs.
    if (!force) {
      confirmCreate = true;
      return;
    }
    mixError = '';
    try {
      const mix = await createMix({ title: name, url: newMixUrl.trim() || null });
      mixes = [mix, ...mixes];
      newMixTitle = '';
      newMixUrl = '';
      confirmCreate = false;
      startAdd(mix.id);
    } catch (e) {
      confirmCreate = false;
      mixError =
        e instanceof DuplicateMixError
          ? `Already tracked as "${e.mix.title}"${e.mix.archivedAt ? ' (archived)' : ''}.`
          : e instanceof Error
            ? e.message
            : 'Could not add that mix.';
    }
  }
</script>

<div class="idt" data-variant={variant}>
  {#if variant === 'page'}
    <header class="page-header">
      <h1 class="page-title">ID Tracker</h1>
      <div class="header-actions">
        <button class="btn" onclick={handleSync} disabled={syncing || !configured}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    </header>
  {/if}

  {#if loading}
    <p class="status-msg">Loading…</p>
  {:else if loadError}
    <p class="status-msg error">{loadError}</p>
  {:else}
    {#if variant === 'widget'}
      <p class="headline">
        <span class="count">{openIdCount}</span> open ID{openIdCount === 1 ? '' : 's'}
      </p>
    {/if}

    {#if syncMessage}<p class="status-msg subtle">{syncMessage}</p>{/if}
    {#if !configured && variant === 'page'}
      <p class="status-msg subtle">
        YouTube sync is off — set YOUTUBE_API_KEY and YOUTUBE_PLAYLIST_IDS. Mixes added by hand
        still work.
      </p>
    {/if}

    {#if variant === 'page'}
      <form class="add-mix" onsubmit={(e) => { e.preventDefault(); void submitMix(); }}>
        <input class="text-input" placeholder="Mix name" bind:value={newMixTitle} />
        <input class="text-input" placeholder="URL (optional)" bind:value={newMixUrl} />
        <button class="btn" type="submit">Add mix</button>
      </form>
      {#if mixError}<p class="status-msg error">{mixError}</p>{/if}

      {#if similarMixes.length > 0}
        <div class="suggestions">
          <span class="status-msg subtle">Already tracked — pick one to add an ID to it:</span>
          <ul class="suggestion-list">
            {#each similarMixes as m (m.id)}
              <li>
                <button
                  class="link-btn suggestion"
                  onclick={() => {
                    newMixTitle = '';
                    newMixUrl = '';
                    startAdd(m.id);
                  }}>{m.title}</button
                >
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <label class="show-archived">
        <input type="checkbox" bind:checked={showArchived} onchange={load} />
        Show archived
      </label>
    {/if}

    {#if visibleMixes.length === 0}
      <p class="status-msg">No mixes yet.</p>
    {:else}
      <ul class="mix-list">
        {#each visibleMixes as mix (mix.id)}
          {@const open = mix.cues.filter((c) => !c.identified).length}
          <li class="mix" class:archived={mix.archivedAt !== null}>
            <div class="mix-head">
              <button
                class="mix-title"
                onclick={() => (expanded = expanded === mix.id ? null : mix.id)}
                aria-expanded={expanded === mix.id}
              >
                <span class="disclosure">{expanded === mix.id ? '▾' : '▸'}</span>
                {mix.title}
              </button>

              {#if mix.pendingRename}
                <button
                  class="warn-icon"
                  title="The video's name on YouTube has changed"
                  onclick={() => (renameFor = mix)}>⚠</button
                >
              {/if}
              {#if mix.unavailable}<span class="chip gone">not on YouTube</span>{/if}
              {#if !mix.inPlaylist && !mix.unavailable}<span class="chip">off playlist</span>{/if}

              <span class="mix-meta">
                {#if mix.durationS}<span class="dim">{formatPosition(mix.durationS)}</span>{/if}
                <span class="id-count" class:has-open={open > 0}>
                  {mix.cues.length} ID{mix.cues.length === 1 ? '' : 's'}{open > 0 ? ` · ${open} open` : ''}
                </span>
                {#if variant === 'page'}
                  <button class="link-btn" onclick={() => void toggleArchive(mix)}>
                    {mix.archivedAt === null ? 'Archive' : 'Restore'}
                  </button>
                {/if}
              </span>
            </div>

            {#if expanded === mix.id}
              <div class="cues">
                {#if mix.cues.length === 0}
                  <p class="status-msg subtle">No IDs logged yet.</p>
                {:else}
                  <ul class="cue-list">
                    {#each mix.cues as cue (cue.id)}
                      {@const href = cueLink(mix, cue.positionS)}
                      <li class="cue" class:identified={cue.identified}>
                        {#if href}
                          <a class="stamp" {href} target="_blank" rel="noopener noreferrer">
                            {formatPosition(cue.positionS)}
                          </a>
                        {:else}
                          <span class="stamp">{formatPosition(cue.positionS)}</span>
                        {/if}
                        <input
                          class="text-input inline"
                          placeholder="Artist"
                          value={cue.artist ?? ''}
                          onchange={(e) => void identify(cue, 'artist', e.currentTarget.value)}
                        />
                        <input
                          class="text-input inline"
                          placeholder="Title"
                          value={cue.title ?? ''}
                          onchange={(e) => void identify(cue, 'title', e.currentTarget.value)}
                        />
                        {#if cue.notes}<span class="notes">{cue.notes}</span>{/if}
                        <button class="link-btn" onclick={() => void removeCue(mix.id, cue.id)}>×</button>
                      </li>
                    {/each}
                  </ul>
                {/if}

                {#if addingTo === mix.id}
                  <form class="add-cue" onsubmit={(e) => { e.preventDefault(); void submitCue(mix); }}>
                    <input
                      class="text-input stamp-input"
                      placeholder="42:15 — or paste a YouTube link"
                      title="A timestamp (42:15, 1:23:45, or plain seconds), or a YouTube URL carrying a t= parameter — the time is read out of it."
                      bind:value={position}
                    />
                    <input class="text-input" placeholder="Artist" bind:value={artist} />
                    <input class="text-input" placeholder="Title" bind:value={title} />
                    <input class="text-input" placeholder="Remixer" bind:value={remixer} />
                    <input class="text-input" placeholder="Notes" bind:value={notes} />
                    <button class="btn" type="submit" disabled={savingCue || !position.trim()}>
                      {savingCue ? 'Saving…' : 'Save ID'}
                    </button>
                  </form>
                  {#if cueError}<p class="status-msg error">{cueError}</p>{/if}
                  {#if cueWarning}<p class="status-msg warn">{cueWarning}</p>{/if}
                {:else}
                  <button class="btn subtle-btn" onclick={() => startAdd(mix.id)}>Add timestamp</button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<Modal open={confirmCreate} title="Add a new mix?" onClose={() => (confirmCreate = false)}>
  {#if similarMixes.length > 0}
    <p class="rename-line">
      These are already tracked under a similar name — is it one of them?
    </p>
    <ul class="suggestion-list modal-list">
      {#each similarMixes as m (m.id)}
        <li>
          <button
            class="link-btn suggestion"
            onclick={() => {
              confirmCreate = false;
              newMixTitle = '';
              newMixUrl = '';
              startAdd(m.id);
            }}>{m.title}</button
          >
        </li>
      {/each}
    </ul>
    <p class="rename-line">
      Otherwise, add <strong>{newMixTitle}</strong> as a separate mix.
    </p>
  {:else}
    <p class="rename-line">
      Add <strong>{newMixTitle}</strong> as a new mix?
    </p>
  {/if}
  <div class="rename-actions">
    <button class="btn" onclick={() => void submitMix(true)}>
      {similarMixes.length > 0 ? 'Add as separate mix' : 'Add it'}
    </button>
    <button class="btn subtle-btn" onclick={() => (confirmCreate = false)}>Cancel</button>
  </div>
</Modal>

<Modal open={renameFor !== null} title="This mix was renamed on YouTube" onClose={() => (renameFor = null)}>
  {#if renameFor}
    <p class="rename-line"><span class="dim">Your name:</span> {renameFor.title}</p>
    <p class="rename-line"><span class="dim">Now on YouTube:</span> {renameFor.pendingRename}</p>
    <div class="rename-actions">
      <button class="btn" onclick={() => renameFor && void handleRename(renameFor, true)}>
        Use YouTube's name
      </button>
      <button class="btn subtle-btn" onclick={() => renameFor && void handleRename(renameFor, false)}>
        Keep mine
      </button>
    </div>
  {/if}
</Modal>

<style lang="scss" src="./IdTracker.scss"></style>
