<script lang="ts">
  import { widgets } from '$lib/widgets';
  import WidgetGrid from '$lib/WidgetGrid.svelte';
</script>

<WidgetGrid pageId="home" widgetList={widgets} />

<style lang="scss" src="./+page.scss"></style>
