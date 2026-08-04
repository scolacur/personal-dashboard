<script lang="ts">
  // The Home grid is the user-facing widget catalogue — `homeWidgets()` rather than the raw
  // registry, so the Dev Ops summary widgets (system: true) stay on /devops.
  import { homeWidgets } from '$lib/widgets';
  import WidgetGrid from '$lib/WidgetGrid.svelte';
</script>

<WidgetGrid pageId="home" widgetList={homeWidgets()} />

<style lang="scss" src="./+page.scss"></style>
