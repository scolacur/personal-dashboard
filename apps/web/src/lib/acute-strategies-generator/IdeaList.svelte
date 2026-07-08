<script lang="ts">
  import type { AcuteStrategyIdea } from '@dashboard/shared';

  interface Props {
    ideas: AcuteStrategyIdea[];
    onEdit: (idea: AcuteStrategyIdea) => void;
    onDelete: (idea: AcuteStrategyIdea) => void;
    onAdd: () => void;
  }

  let { ideas, onEdit, onDelete, onAdd }: Props = $props();
</script>

<div class="idea-list">
  <div class="list-header">
    <span class="count">{ideas.length} idea{ideas.length !== 1 ? 's' : ''}</span>
    <button class="btn-add" onclick={onAdd}>+ Add Idea</button>
  </div>

  {#if ideas.length === 0}
    <p class="empty">No ideas yet. Add one!</p>
  {:else}
    <ul class="list">
      {#each ideas as idea (idea.id)}
        <li class="item">
          <div class="item-body">
            <span class="item-text">{idea.text}</span>
            <div class="item-meta">
              <span class="type-badge type-{idea.type.toLowerCase()}">{idea.type}</span>
              {#each idea.tags as tag (tag)}
                <span class="tag">{tag}</span>
              {/each}
            </div>
          </div>
          <div class="item-actions">
            <button class="btn-edit" onclick={() => onEdit(idea)}>Edit</button>
            <button class="btn-delete" onclick={() => onDelete(idea)}>Delete</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style lang="scss" src="./IdeaList.scss"></style>
