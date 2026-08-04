<script lang="ts">
  // Dev Ops overview (PD-413): an Arrange-able grid of summary widgets, one per subpage.
  // The widgets themselves are registered in `$lib/widgets.ts` tagged `pages: ['devops']`;
  // layouts persist to `dashboard:layout:devops` via `$lib/layout.ts` (D-053).
  //
  // No sibling +page.scss: WidgetGrid carries all the grid styling.
  import WidgetGrid from '$lib/WidgetGrid.svelte';
  import { widgetsForPage } from '$lib/widgets';
</script>

<WidgetGrid pageId="devops" widgetList={widgetsForPage('devops')} />
