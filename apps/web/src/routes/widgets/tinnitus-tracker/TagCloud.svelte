<script lang="ts">
  import { normalizeTagName, TINNITUS_TAG_MAX_LENGTH } from '@dashboard/shared';

  /**
   * Toggleable tag chips plus a "+ custom" chip. Custom tags persist (the parent saves them).
   * "Edit" mode shows a × on each chip to hide it from the cloud. Past entries keep hidden tags.
   * `compact` only shrinks the chips. `editable` controls the edit toggle, which is page-only (PD-716).
   */
  interface Props {
    /** Tag names shown in the cloud, in display order. */
    tags: string[];
    selected: string[];
    /** Smaller chips (the dashboard card). */
    compact?: boolean;
    /** Show the edit toggle for hiding tags. Page-only (PD-716). */
    editable?: boolean;
    /** Show the "+ custom" chip. Off in the entry edit dialog. */
    addable?: boolean;
    onAdd?: (name: string) => void;
    onHide?: (name: string) => void;
  }

  let { tags, selected = $bindable(), compact = false, editable = false, addable = true, onAdd, onHide }: Props = $props();

  let adding = $state(false);
  let draft = $state('');
  let editing = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (adding) input?.focus();
  });

  function toggle(name: string) {
    selected = selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name];
  }

  function commitDraft() {
    const name = normalizeTagName(draft);
    adding = false;
    draft = '';
    if (name === '') return;
    if (!tags.includes(name)) onAdd?.(name);
    if (!selected.includes(name)) selected = [...selected, name];
  }

  function onDraftKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Escape') {
      adding = false;
      draft = '';
    }
  }
</script>

<div class="cloud" class:compact>
  {#each tags as name (name)}
    <span class="chip-wrap">
      <button
        type="button"
        class="chip"
        class:on={selected.includes(name)}
        aria-pressed={selected.includes(name)}
        onclick={() => toggle(name)}
      >
        {name}
      </button>
      {#if editing}
        <button type="button" class="hide" aria-label="Hide tag {name}" onclick={() => onHide?.(name)}>×</button>
      {/if}
    </span>
  {/each}

  {#if addable}
    {#if adding}
      <input
        bind:this={input}
        bind:value={draft}
        class="chip draft"
        maxlength={TINNITUS_TAG_MAX_LENGTH}
        placeholder="new tag"
        aria-label="New tag name"
        enterkeyhint="done"
        onkeydown={onDraftKey}
        onblur={commitDraft}
      />
    {:else}
      <button type="button" class="chip add" onclick={() => (adding = true)}>+ custom</button>
    {/if}
  {/if}
  {#if editable}
    <button type="button" class="edit-toggle" aria-pressed={editing} onclick={() => (editing = !editing)}>
      {editing ? 'done' : 'edit'}
    </button>
  {/if}
</div>

<style lang="scss" src="./TagCloud.scss"></style>
