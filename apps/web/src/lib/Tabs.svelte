<script lang="ts">
  import type { Snippet } from 'svelte';

  // A top tab bar. Chosen over left/right/bottom because it is the only placement that keeps one
  // shape at every width — the others have to collapse into something else on a phone, which
  // means two layouts to maintain for three tabs. Bottom additionally collides with anything
  // fixed to the bottom of the viewport.
  //
  // The component owns the panel as well as the bar, via the `panel` snippet. That is deliberate:
  // the tab/panel ARIA wiring (`aria-controls`, `aria-labelledby`, roving tabindex) is easy to
  // half-do, and a caller that renders its own panels has to repeat all of it correctly.

  export interface TabDef {
    id: string;
    label: string;
    /** Shown as a badge. Omit or null for no badge; 0 renders, because "0 matches" is a fact. */
    count?: number | null;
  }

  let {
    tabs,
    active = $bindable(),
    panel,
    storeKey,
    label = 'Sections',
  }: {
    tabs: TabDef[];
    active: string;
    panel: Snippet<[string]>;
    /** Persists the selected tab under this key. Omit to not persist. */
    storeKey?: string;
    /** Accessible name for the tablist. */
    label?: string;
  } = $props();

  // Inlined rather than extracted to a store module: there is one caller. `collapse-store.ts`
  // exists because two components had already hand-rolled the same dance — extract when that
  // happens here too, not before.
  const PREFIX = 'tm.tabs.';

  function persist(id: string): void {
    if (!storeKey || typeof localStorage === 'undefined') return;
    localStorage.setItem(PREFIX + storeKey, id);
  }

  // Restore on mount. Validated against the current tabs, so renaming or removing a tab can't
  // strand someone on a panel that no longer exists.
  $effect(() => {
    if (!storeKey || typeof localStorage === 'undefined') return;
    const saved = localStorage.getItem(PREFIX + storeKey);
    if (saved && saved !== active && tabs.some((t) => t.id === saved)) active = saved;
  });

  let barEl = $state<HTMLDivElement | null>(null);

  function select(id: string): void {
    active = id;
    persist(id);
  }

  /**
   * Arrow-key navigation across the bar, per the ARIA tabs pattern.
   *
   * Bound to each **tab**, not to the tablist: the tabs are what hold focus (roving tabindex),
   * and a tablist carrying a key handler would need a tabindex of its own, which would put a
   * non-interactive container into the tab order.
   *
   * Selection follows focus, which is correct here because switching tabs is cheap and has no
   * side effects — every panel's data is already loaded by the page.
   */
  function onKeydown(e: KeyboardEvent): void {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();

    const i = tabs.findIndex((t) => t.id === active);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : e.key === 'ArrowRight'
            ? (i + 1) % tabs.length
            : (i - 1 + tabs.length) % tabs.length;

    select(tabs[next].id);
    // Move focus with the selection, or the next arrow press starts from the old tab.
    barEl?.querySelector<HTMLButtonElement>(`#tab-${CSS.escape(tabs[next].id)}`)?.focus();
  }
</script>

<div class="tabs-root">
  <div class="tabs-bar" role="tablist" aria-label={label} bind:this={barEl}>
    {#each tabs as tab (tab.id)}
      {@const selected = tab.id === active}
      <button
        type="button"
        class="tab"
        class:selected
        role="tab"
        id="tab-{tab.id}"
        aria-selected={selected}
        aria-controls="panel-{tab.id}"
        tabindex={selected ? 0 : -1}
        onclick={() => select(tab.id)}
        onkeydown={onKeydown}
      >
        <span class="tab-label">{tab.label}</span>
        {#if tab.count != null}
          <span class="tab-count" class:zero={tab.count === 0}>{tab.count}</span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="tab-panel" role="tabpanel" id="panel-{active}" aria-labelledby="tab-{active}" tabindex="0">
    {@render panel(active)}
  </div>
</div>

<style lang="scss" src="./Tabs.scss"></style>
