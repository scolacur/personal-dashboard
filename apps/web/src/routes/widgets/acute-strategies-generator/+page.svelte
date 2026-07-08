<script lang="ts">
  import { onMount } from 'svelte';
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';
  import { fetchIdeas, createIdea, updateIdea, deleteIdea } from './api';
  import IdeaList from './IdeaList.svelte';
  import IdeaEditModal from './IdeaEditModal.svelte';

  type View = 'front' | 'back';

  let view = $state<View>('front');
  let ideas = $state<AcuteStrategyIdea[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  // Front-view state
  let typeFilter = $state<'All' | IdeaType>('All');
  let tagFilter = $state('');
  let currentIdea = $state<AcuteStrategyIdea | null>(null);

  // Edit modal state
  let editingIdea = $state<AcuteStrategyIdea | null | undefined>(undefined); // undefined = closed

  let filteredIdeas = $derived(
    ideas.filter((idea) => {
      if (typeFilter !== 'All' && idea.type !== typeFilter) return false;
      if (tagFilter.trim()) {
        const needle = tagFilter.trim().toLowerCase();
        if (!idea.tags.some((t) => t.toLowerCase() === needle)) return false;
      }
      return true;
    }),
  );

  function pickRandom(pool: AcuteStrategyIdea[]): AcuteStrategyIdea | null {
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function shuffle() {
    currentIdea = pickRandom(filteredIdeas);
  }

  $effect(() => {
    // Re-pick when filters change and current idea no longer matches
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
  });

  async function handleSave(data: { text: string; type: IdeaType; tags: string[] }) {
    if (editingIdea) {
      const updated = await updateIdea(editingIdea.id, data);
      ideas = ideas.map((i) => (i.id === updated.id ? updated : i));
      if (currentIdea?.id === updated.id) currentIdea = updated;
    } else {
      const created = await createIdea(data);
      ideas = [...ideas, created];
    }
    editingIdea = undefined;
  }

  async function handleDelete(idea: AcuteStrategyIdea) {
    if (!confirm(`Delete "${idea.text.slice(0, 60)}…"?`)) return;
    await deleteIdea(idea.id);
    ideas = ideas.filter((i) => i.id !== idea.id);
    if (currentIdea?.id === idea.id) currentIdea = pickRandom(filteredIdeas.filter((i) => i.id !== idea.id));
  }
</script>

<div class="asg-page">
  <header class="page-header">
    <h1 class="page-title">Acute Strategies Generator</h1>
    <button
      class="view-toggle"
      onclick={() => (view = view === 'front' ? 'back' : 'front')}
    >
      {view === 'front' ? 'Manage Ideas' : '← Back'}
    </button>
  </header>

  {#if loading}
    <p class="status-msg">Loading…</p>
  {:else if loadError}
    <p class="status-msg error">{loadError}</p>
  {:else if view === 'front'}
    <div class="front-view">
      <div class="idea-display">
        {#if currentIdea}
          <div class="idea-type-label">{currentIdea.type}</div>
          <p class="idea-text">{currentIdea.text}</p>
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
          <label class="filter-label" for="type-filter">Type</label>
          <select id="type-filter" class="filter-select" bind:value={typeFilter}>
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
          <label class="filter-label" for="tag-filter">Tag</label>
          <input
            id="tag-filter"
            class="filter-input"
            type="text"
            placeholder="Filter by tag"
            bind:value={tagFilter}
          />
        </div>
      </div>

      <p class="pool-size">
        {filteredIdeas.length} idea{filteredIdeas.length !== 1 ? 's' : ''} in pool
      </p>
    </div>
  {:else}
    <IdeaList
      {ideas}
      onEdit={(idea) => (editingIdea = idea)}
      onDelete={handleDelete}
      onAdd={() => (editingIdea = null)}
    />
  {/if}
</div>

{#if editingIdea !== undefined}
  <IdeaEditModal
    idea={editingIdea}
    onSave={handleSave}
    onCancel={() => (editingIdea = undefined)}
  />
{/if}

<style lang="scss" src="./+page.scss"></style>
