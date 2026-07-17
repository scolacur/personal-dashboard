<script lang="ts">
  import WidgetGrid from '$lib/WidgetGrid.svelte';
  import { widgetsForPage } from '$lib/widgets';

  let { pageId }: { pageId: string } = $props();

  const pageWidgets = $derived(widgetsForPage(pageId));
</script>

<WidgetGrid {pageId} widgetList={pageWidgets} />

<style lang="scss" src="./PageStub.scss"></style>
