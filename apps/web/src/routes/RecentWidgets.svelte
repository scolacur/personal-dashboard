<script lang="ts">
  /**
   * Home's recently-used view (PD-751, Home shows recently used widgets).
   *
   * Renders the same `<Widget>` card every grid uses, at each widget's default span, with no
   * Arrange, no remove, and no ghost "+" card: the contents are derived from usage, not curated,
   * so there is nothing here to add to or rearrange. Like the Library page, it is a derived view.
   */
  import Widget from '$lib/Widget.svelte';
  import { defaultSpan, type WidgetMeta } from '$lib/widgets';

  let { widgets }: { widgets: WidgetMeta[] } = $props();
</script>

<p class="recent-intro">Recently used</p>

<div class="grid">
  {#each widgets as widget (widget.id)}
    {@const span = defaultSpan(widget)}
    <Widget
      widgetId={widget.id}
      title={widget.title}
      description={widget.description}
      route={widget.route}
      embed={widget.embed}
      cols={span.cols}
      rows={span.rows}
    />
  {/each}
</div>

<style lang="scss" src="./RecentWidgets.scss"></style>
