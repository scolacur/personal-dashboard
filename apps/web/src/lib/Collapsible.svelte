<script lang="ts">
  import type { Snippet } from 'svelte';

  // A section with a clickable header that collapses its body (C4/PD-345 detail-page redesign).
  // The Overview sections — Description, Relations, Robot activity, Runs — can each get long and
  // push the rest of the page down, so each is collapsible. Open state persists per key in
  // localStorage so a section a user closes stays closed across visits.
  const {
    title,
    count,
    open: openDefault = true,
    storeKey,
    children,
    actions,
  }: {
    title: string;
    count?: number | null;
    open?: boolean;
    storeKey?: string;
    children: Snippet;
    /** Optional controls pinned to the right of the header, shown only while open. Rendered
     *  as a sibling of the header button — nesting them inside it would be invalid HTML and
     *  would swallow their clicks into the collapse toggle. */
    actions?: Snippet;
  } = $props();

  const key = $derived(storeKey ? `tm.collapsible.${storeKey}` : null);

  function initial(): boolean {
    if (typeof localStorage === 'undefined' || !key) return openDefault;
    const v = localStorage.getItem(key);
    return v === null ? openDefault : v === '1';
  }

  let open = $state(initial());

  function toggle(): void {
    open = !open;
    if (key && typeof localStorage !== 'undefined') localStorage.setItem(key, open ? '1' : '0');
  }
</script>

<section class="collapsible" class:open>
  <div class="collapsible-head-row">
    <button class="collapsible-head" type="button" aria-expanded={open} onclick={toggle}>
      <span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      <span class="collapsible-title">{title}</span>
      {#if count != null}<span class="collapsible-count">{count}</span>{/if}
    </button>
    {#if open && actions}
      <div class="collapsible-actions">{@render actions()}</div>
    {/if}
  </div>
  {#if open}
    <div class="collapsible-body">
      {@render children()}
    </div>
  {/if}
</section>

<style lang="scss" src="./Collapsible.scss"></style>
