<script lang="ts">
  import Widget from '$lib/Widget.svelte';
  import { pageById } from '$lib/pages';
  import { widgetsForPage } from '$lib/widgets';

  // Shared scaffold for a top-level page route. Given a page id it renders the
  // page heading + description and a tile grid of the widgets assigned to it.
  let { pageId }: { pageId: string } = $props();

  const meta = $derived(pageById(pageId));
  const pageWidgets = $derived(widgetsForPage(pageId));
</script>

<header class="page-head">
  <h1>{meta?.title ?? pageId}</h1>
  {#if meta?.description}
    <p class="page-desc">{meta.description}</p>
  {/if}
</header>

{#if pageWidgets.length === 0}
  <p class="page-empty">No widgets here yet — this page is stubbed out.</p>
{:else}
  <div class="grid">
    {#each pageWidgets as w (w.route)}
      <Widget title={w.title} description={w.description} route={w.route} />
    {/each}
  </div>
{/if}

<style lang="scss" src="./PageStub.scss"></style>
