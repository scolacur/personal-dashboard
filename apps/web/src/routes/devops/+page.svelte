<script lang="ts">
  // Dev Ops overview (PD-413): an Arrange-able grid of summary widgets, one per subpage.
  // Membership is user state served from `shell_page_widgets` (D-073) — the summaries were
  // seeded onto this page but are ordinary library widgets and can be placed anywhere.
  //
  // No sibling +page.scss: WidgetGrid carries all the grid styling.
  import WidgetGrid from '$lib/WidgetGrid.svelte';
</script>

<WidgetGrid pageId="devops" />
