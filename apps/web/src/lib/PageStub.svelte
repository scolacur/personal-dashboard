<script lang="ts">
  import WidgetGrid from '$lib/WidgetGrid.svelte';

  // Membership is the grid's own concern now (D-073) — this just names the page.
  let { pageId }: { pageId: string } = $props();
</script>

<WidgetGrid {pageId} />

<style lang="scss" src="./PageStub.scss"></style>
