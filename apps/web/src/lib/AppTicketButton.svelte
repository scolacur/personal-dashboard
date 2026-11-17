<script lang="ts">
  import { MessageSquarePlus } from 'lucide-svelte';
  import TicketComposeModal from './TicketComposeModal.svelte';

  // The top-nav suggestion button: the broadest of the three scopes — a change to the dashboard
  // as a whole (navigation, theming, a new page, cross-cutting behaviour). Page-specific asks go
  // through the footer at the bottom of each page; widget-specific ones through the card's +.
  let open = $state(false);
</script>

<button
  type="button"
  class="app-ticket-btn"
  onclick={() => (open = true)}
  aria-label="Suggest a change to the app"
  title="Suggest a change to the app"
>
  <MessageSquarePlus size={16} />
</button>

<TicketComposeModal
  {open}
  surface={{ kind: 'app' }}
  label="App"
  placeholder="What should change about the dashboard as a whole?"
  onClose={() => (open = false)}
/>

<style lang="scss" src="./AppTicketButton.scss"></style>
