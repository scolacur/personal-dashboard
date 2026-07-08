<script lang="ts">
  import Widget from '$lib/Widget.svelte';
  import { widgetsForPage } from '$lib/widgets';

  let { pageId }: { pageId: string } = $props();

  const pageWidgets = $derived(widgetsForPage(pageId));
</script>

{#if pageWidgets.length === 0}
  <p class="page-empty">No widgets here yet — this page is stubbed out.</p>
{:else}
  <div class="grid">
    {#each pageWidgets as w (w.route)}
      <Widget title={w.title} description={w.description} route={w.route} embed={w.embed} />
    {/each}
  </div>
{/if}

<style lang="scss" src="./PageStub.scss"></style>
