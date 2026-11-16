<script lang="ts">
  import { onMount } from 'svelte';
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyDraw, AcuteStrategyIdea, IdeaType } from '@dashboard/shared';
  import {
    fetchIdeas,
    createIdea,
    updateIdea,
    deleteIdea,
    importIdeas,
    recordDraw,
    fetchDraws,
  } from './acute-strategies-generator/api';
  import IdeaList from './acute-strategies-generator/IdeaList.svelte';
  import IdeaEditModal from './acute-strategies-generator/IdeaEditModal.svelte';
  import ImportModal from './acute-strategies-generator/ImportModal.svelte';
  import RecentDraws from './acute-strategies-generator/RecentDraws.svelte';
  import { deriveAllTags, filterIdeas, pickRandom } from './acute-strategies-generator/utils';
  import { ideasToText } from './acute-strategies-generator/import-export';
  import {
    drawFromDeck,
    deckProgress,
    loadDeckMode,
    saveDeckMode,
    loadDeckSeen,
    saveDeckSeen,
  } from './acute-strategies-generator/deck';

  interface Props {
    variant: 'widget' | 'page';
    /** Controls which face is shown in widget variant; ignored in page variant. */
    view?: 'generator' | 'manage';
  }

  let { variant, view = 'generator' }: Props = $props();

  // Page variant tracks its own view state
  let internalView = $state<'generator' | 'manage'>('generator');

  // Effective view: page variant uses internalView, widget variant uses prop
  const effectiveView = $derived<'generator' | 'manage'>(
    variant === 'page' ? internalView : view,
  );

  let ideas = $state<AcuteStrategyIdea[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  let typeFilter = $state<'All' | IdeaType>('All');
  let tagFilter = $state('');
  let currentIdea = $state<AcuteStrategyIdea | null>(null);
  let editingIdea = $state<AcuteStrategyIdea | null | undefined>(undefined);
  let importing = $state(false);

  let allTags = $derived(deriveAllTags(ideas));
  let filteredIdeas = $derived(filterIdeas(ideas, typeFilter, tagFilter));

  // ── Deck Mode (T67): no repeats until the current pool has been seen ──
  let deckMode = $state(loadDeckMode());
  let deckSeen = $state<number[]>(loadDeckSeen());
  let deckStatus = $derived(deckProgress(filteredIdeas, deckSeen));

  // ── Draw History (T70): page variant shows recent draws; the card does not. ──
  let draws = $state<AcuteStrategyDraw[]>([]);

  function shuffle() {
    if (deckMode) {
      const { idea, seenIds } = drawFromDeck(filteredIdeas, deckSeen, currentIdea?.id ?? null);
      deckSeen = seenIds;
      saveDeckSeen(deckSeen);
      currentIdea = idea;
    } else {
      currentIdea = pickRandom(filteredIdeas);
    }
    // Only a press of Shuffle that actually shows an idea counts as a draw — not
    // the auto-pick on load, nor the re-pick a filter change triggers (T70).
    if (currentIdea) void logDraw(currentIdea.id);
  }

  // Record the draw, then refresh the recent-draws list on the page. A failed
  // record must never block or undo the draw — log it and move on (T70).
  async function logDraw(ideaId: number) {
    try {
      await recordDraw(ideaId);
      if (variant === 'page') draws = await fetchDraws();
    } catch (err) {
      console.error('Failed to record draw', err);
    }
  }

  function toggleDeckMode() {
    deckMode = !deckMode;
    saveDeckMode(deckMode);
  }

  function resetDeck() {
    deckSeen = [];
    saveDeckSeen(deckSeen);
  }

  $effect(() => {
    if (currentIdea && !filteredIdeas.some((i) => i.id === currentIdea!.id)) {
      currentIdea = pickRandom(filteredIdeas);
    } else if (!currentIdea && filteredIdeas.length > 0) {
      currentIdea = pickRandom(filteredIdeas);
    }
  });

  onMount(async () => {
    try {
      ideas = await fetchIdeas();
      currentIdea = pickRandom(ideas);
    } catch {
      loadError = 'Failed to load ideas.';
    } finally {
      loading = false;
    }
    // Draw history is a page-only section; the card has no room for it (T70). A
    // failure here just leaves the list empty — it must not block the generator.
    if (variant === 'page') {
      try {
        draws = await fetchDraws();
      } catch (err) {
        console.error('Failed to load draws', err);
      }
    }
  });

  // Persists + refreshes the list only. Closing the modal is the modal's call
  // (onCancel) so that "Save and add another" can keep it open (T546).
  async function handleSave(data: { text: string; type: IdeaType; tags: string[] }) {
    if (editingIdea) {
      const updated = await updateIdea(editingIdea.id, data);
      ideas = ideas.map((i) => (i.id === updated.id ? updated : i));
      if (currentIdea?.id === updated.id) currentIdea = updated;
    } else {
      const created = await createIdea(data);
      ideas = [...ideas, created];
    }
  }

  // Commit a batch import, then append the created ideas without a reload (T69).
  async function handleImport(lines: string[], type: IdeaType, tags: string[]) {
    const { created } = await importIdeas({ lines, type, tags });
    ideas = [...ideas, ...created];
    return created;
  }

  // Download every idea's text, one per line, in list order (T69).
  function handleExport() {
    const blob = new Blob([ideasToText(ideas)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'acute-strategies.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(idea: AcuteStrategyIdea) {
    if (!confirm(`Delete "${idea.text.slice(0, 60)}…"?`)) return;
    await deleteIdea(idea.id);
    ideas = ideas.filter((i) => i.id !== idea.id);
    if (currentIdea?.id === idea.id) {
      currentIdea = pickRandom(filteredIdeas.filter((i) => i.id !== idea.id));
    }
  }
</script>

<div class="asg" data-variant={variant}>
  {#if variant === 'page'}
    <header class="page-header">
      <h1 class="page-title">Acute Strategies Generator</h1>
      <button
        class="view-toggle"
        onclick={() => (internalView = internalView === 'generator' ? 'manage' : 'generator')}
      >
        {internalView === 'generator' ? 'Manage Ideas' : '← Back'}
      </button>
    </header>
  {/if}

  {#if loading}
    <p class="status-msg">Loading…</p>
  {:else if loadError}
    <p class="status-msg error">{loadError}</p>
  {:else if effectiveView === 'generator'}
    <div class="generator-view">
      <div class="idea-display">
        {#if currentIdea}
          <p class="idea-text idea-text--{currentIdea.type.toLowerCase()}">{currentIdea.text}</p>
          {#if currentIdea.tags.length > 0}
            <div class="idea-tags">
              {#each currentIdea.tags as tag (tag)}
                <span class="tag">{tag}</span>
              {/each}
            </div>
          {/if}
        {:else}
          <p class="idea-empty">No ideas match your filters.</p>
        {/if}
      </div>

      <div class="controls">
        <div class="control-left">
          <label class="filter-label" for="asg-type-filter">Type</label>
          <select id="asg-type-filter" class="filter-select" bind:value={typeFilter}>
            <option value="All">All</option>
            {#each IDEA_TYPES as t (t)}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </div>

        <button class="shuffle-btn" onclick={shuffle} disabled={filteredIdeas.length === 0}>
          Shuffle
        </button>

        <div class="control-right">
          <label class="filter-label" for="asg-tag-filter">Tag</label>
          <input
            id="asg-tag-filter"
            class="filter-input"
            type="text"
            placeholder="Filter by tag"
            list="asg-tag-options"
            bind:value={tagFilter}
          />
          <datalist id="asg-tag-options">
            {#each allTags as tag (tag)}
              <option value={tag}></option>
            {/each}
          </datalist>
        </div>
      </div>

      <div class="deck-controls">
        <label class="deck-toggle">
          <input type="checkbox" checked={deckMode} onchange={toggleDeckMode} />
          Deck mode
        </label>
        {#if deckMode}
          <span class="deck-progress">{deckStatus.seen} of {deckStatus.total} seen</span>
          <button class="reset-deck-btn" onclick={resetDeck}>Reset deck</button>
        {/if}
      </div>

      <div class="generator-footer">
        <p class="pool-size">
          {filteredIdeas.length} idea{filteredIdeas.length !== 1 ? 's' : ''} in pool
        </p>
        <button class="add-idea-btn" onclick={() => (editingIdea = null)}>+ New idea</button>
      </div>

      {#if variant === 'page'}
        <RecentDraws {draws} />
      {/if}
    </div>
  {:else}
    <div class="manage-view">
      <IdeaList
        {ideas}
        onEdit={(idea) => (editingIdea = idea)}
        onDelete={handleDelete}
        onAdd={() => (editingIdea = null)}
        onImport={() => (importing = true)}
        onExport={handleExport}
      />
    </div>
  {/if}
</div>

{#if editingIdea !== undefined}
  <IdeaEditModal
    idea={editingIdea}
    onSave={handleSave}
    onCancel={() => (editingIdea = undefined)}
  />
{/if}

{#if importing}
  <ImportModal
    existingTexts={ideas.map((i) => i.text)}
    onImport={handleImport}
    onCancel={() => (importing = false)}
  />
{/if}

<style lang="scss" src="./AcuteStrategiesGenerator.scss"></style>
