<script lang="ts">
  /**
   * The Library page (PD-334, D-071) — reached by the **All Widgets** button at the bottom of
   * the side nav.
   *
   * A **derived view, not a page**: no membership row, no Arrange, no ghost "+" card, and no
   * entry in `pages.ts`. That is what makes "the library shows every widget" true by
   * construction — there is no surface anywhere that can remove a widget from it, so it is
   * always the place to recover something you took off a page.
   *
   * Widgets mount **live** rather than as static previews: the point of browsing a catalogue is
   * seeing what you would actually be adding. Six of the seventeen fetch on visit, against three
   * on Home before D-071. Worth revisiting past roughly fifteen embeds, where lazy mounting on
   * scroll is the upgrade path.
   *
   * Note it is not Arrange-able and needs no guard to make that so: `arrangeablePageId` matches
   * against `pages.ts`, which this route is deliberately absent from, so the Arrange button
   * never lights up here.
   */
  import Widget from '$lib/Widget.svelte';
  import { widgets } from '$lib/widgets';
</script>

<p class="library-intro">
  Every widget in the dashboard. Add one to a page from that page's <strong>+</strong> card.
</p>

<div class="grid">
  {#each widgets as widget (widget.id)}
    <Widget
      title={widget.title}
      description={widget.description}
      route={widget.route}
      embed={widget.embed}
    />
  {/each}
</div>

<style lang="scss" src="./+page.scss"></style>
