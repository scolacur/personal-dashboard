<script lang="ts">
  /**
   * Toggleable tag chips plus a "+ custom" chip. Custom tags persist (the parent saves them).
   * "Edit" mode shows a × on each chip to hide it from the cloud. Past entries keep hidden tags.
   * `compact` only shrinks the chips. `editable` controls the edit toggle, which is page-only (PD-716).
   *
   * Lifted from the Tinnitus Tracker so the Sleep Journal can share it (PD-51, Sleep Journal widget).
   * Two modes:
   *  - **on/off** (default): `selected` holds the names that are on.
   *  - **counted** (`counted`): `counts` maps each on tag to a whole number. Tapping an off tag turns
   *    it on at ×1 and reveals − / + on the chip; − at 1 turns it off. Tapping the name of an on chip
   *    does nothing, so a stray tap never loses a count.
   */
  interface Props {
    /** Tag names shown in the cloud, in display order. */
    tags: string[];
    /** On/off mode: the names that are on. */
    selected?: string[];
    /** Counted mode: name → count for each tag that is on. */
    counts?: Record<string, number>;
    counted?: boolean;
    /** Counted mode: the highest count the + button reaches (default 20). The lowest is always 1. */
    maxCount?: number;
    /** Smaller chips (the dashboard card). */
    compact?: boolean;
    /** Show the edit toggle for hiding tags. Page-only (PD-716). */
    editable?: boolean;
    /** Show the "+ custom" chip. Off in the entry edit dialog. */
    addable?: boolean;
    /** Canonicalises a typed name. Defaults to trimming and collapsing whitespace. */
    normalize?: (raw: string) => string;
    /** Max length of a typed name. */
    maxLength?: number;
    onAdd?: (name: string) => void;
    onHide?: (name: string) => void;
  }

  let {
    tags,
    selected = $bindable([]),
    counts = $bindable({}),
    counted = false,
    maxCount = 20,
    compact = false,
    editable = false,
    addable = true,
    normalize = (raw: string) => raw.trim().replace(/\s+/g, ' '),
    maxLength = 32,
    onAdd,
    onHide,
  }: Props = $props();

  let adding = $state(false);
  let draft = $state('');
  let editing = $state(false);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (adding) input?.focus();
  });

  const isOn = (name: string) => (counted ? (counts[name] ?? 0) > 0 : selected.includes(name));

  function toggle(name: string) {
    selected = selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name];
  }

  function setCount(name: string, n: number) {
    const next = { ...counts };
    if (n <= 0) delete next[name];
    else next[name] = Math.min(maxCount, n);
    counts = next;
  }

  function turnOn(name: string) {
    if (counted) {
      if (!isOn(name)) setCount(name, 1);
    } else if (!selected.includes(name)) {
      selected = [...selected, name];
    }
  }

  function commitDraft() {
    const typed = normalize(draft);
    adding = false;
    draft = '';
    if (typed === '') return;
    // An existing tag spelled with different case is the same tag.
    const name = tags.find((t) => t.toLowerCase() === typed.toLowerCase()) ?? typed;
    if (!tags.includes(name)) onAdd?.(name);
    turnOn(name);
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
      {#if counted && isOn(name)}
        <span class="chip on counted" role="group" aria-label="{name}, ×{counts[name]}">
          <span class="name">{name}</span>
          <button type="button" class="step" aria-label="One less {name}" onclick={() => setCount(name, counts[name] - 1)}
            >−</button
          >
          <span class="count" aria-live="polite">{counts[name]}</span>
          <button
            type="button"
            class="step"
            aria-label="One more {name}"
            disabled={counts[name] >= maxCount}
            onclick={() => setCount(name, counts[name] + 1)}>+</button
          >
        </span>
      {:else}
        <button
          type="button"
          class="chip"
          class:on={isOn(name)}
          aria-pressed={isOn(name)}
          onclick={() => (counted ? turnOn(name) : toggle(name))}
        >
          {name}
        </button>
      {/if}
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
        maxlength={maxLength}
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
