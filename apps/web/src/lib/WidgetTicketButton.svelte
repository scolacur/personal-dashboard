<script lang="ts">
  import TicketComposeModal from './TicketComposeModal.svelte';

  // The + floating in a widget card's bottom-left corner (PD-734). The narrowest of the three
  // suggestion scopes; the page footer and the app-wide nav button share the same dialog.
  const { widgetId, widgetTitle, route }: { widgetId: string; widgetTitle: string; route: string } =
    $props();

  let open = $state(false);

  function openModal(e: MouseEvent) {
    // The card's stretched link sits underneath; never let this click navigate.
    e.preventDefault();
    e.stopPropagation();
    open = true;
  }
</script>

<button
  type="button"
  class="widget-ticket-btn"
  aria-label={`Submit a ticket for ${widgetTitle}`}
  title="Submit a ticket for this widget"
  onclick={openModal}>+</button
>

<TicketComposeModal
  {open}
  surface={{ kind: 'widget', widgetId, widgetTitle, route }}
  label={widgetTitle}
  placeholder="What should change about this widget?"
  onClose={() => (open = false)}
/>

<style lang="scss" src="./WidgetTicketButton.scss"></style>
