<script lang="ts">
  import { onMount } from 'svelte';
  import { IDEA_TYPES } from '@dashboard/shared';
  import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';
  import { fetchIdeas, createIdea, updateIdea, deleteIdea } from './acute-strategies-generator/api';
  import IdeaList from './acute-strategies-generator/IdeaList.svelte';
  import IdeaEditModal from './acute-strategies-generator/IdeaEditModal.svelte';
  import { deriveAllTags, filterIdeas, pickRandom } from './acute-strategies-generator/utils';

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

  let allTags = $derived(deriveAllTags(ideas));
  let filteredIdeas = $derived(filterIdeas(ideas, typeFilter, tagFilter));

  function shuffle() {
    currentIdea = pickRandom(filteredIdeas);
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

      <p class="pool-size">
        {filteredIdeas.length} idea{filteredIdeas.length !== 1 ? 's' : ''} in pool
      </p>
    </div>
  {:else}
    <div class="manage-view">
      <IdeaList
        {ideas}
        onEdit={(idea) => (editingIdea = idea)}
        onDelete={handleDelete}
        onAdd={() => (editingIdea = null)}
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

<style lang="scss" src="./AcuteStrategiesGenerator.scss"></style>
