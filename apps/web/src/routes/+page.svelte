<script lang="ts">
  // Home is an ordinary curated page since D-071 — no longer the auto-catalogue of every
  // widget. That job belongs to the Library page ("All Widgets"), which is the one surface
  // guaranteed to show everything.
  import WidgetGrid from '$lib/WidgetGrid.svelte';
</script>

<WidgetGrid pageId="home" />

<style lang="scss" src="./+page.scss"></style>
