<script lang="ts">
  import { MessageSquarePlus } from 'lucide-svelte';
  import TicketComposeModal from './TicketComposeModal.svelte';

  // The footer at the bottom of every page: a suggestion scoped to the page as a whole — its
  // layout, what's on it, what's missing. Between the widget card + (one widget) and the
  // app-wide nav button (the whole dashboard). Mounted once by the root layout.
  const { pageTitle, route }: { pageTitle: string; route: string } = $props();

  let open = $state(false);
</script>

<footer class="page-ticket-footer">
  <button type="button" class="page-ticket-btn" onclick={() => (open = true)}>
    <MessageSquarePlus size={14} aria-hidden="true" />
    <span>Suggest a change to this page</span>
  </button>
</footer>

<TicketComposeModal
  {open}
  surface={{ kind: 'page', pageTitle, route }}
  label={pageTitle}
  placeholder={`What should change about the ${pageTitle} page?`}
  onClose={() => (open = false)}
/>

<style lang="scss" src="./PageTicketFooter.scss"></style>
