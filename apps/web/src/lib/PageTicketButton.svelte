<script lang="ts">
  import { MessageSquarePlus } from 'lucide-svelte';
  import { page } from '$app/state';
  import { resolvePageTitle } from '$lib/nav-utils';
  import { widgets } from '$lib/widgets';
  import TicketComposeModal from './TicketComposeModal.svelte';

  // "Change something": a suggestion scoped to the page as a whole — its layout, what's on it,
  // what's missing. Between the widget card + (one widget) and the app-wide nav button (the whole
  // dashboard). It used to be a footer link at the bottom of every page; it floats now, in the
  // FloatDock, so it is reachable without scrolling to the end of a long page.
  //
  // The page title and route are read here rather than passed in, so the ticket-detail page can
  // mount its own instance beside the Refine chat without re-deriving them.
  const widgetRoutes = widgets.map((w) => ({ route: w.route, title: w.title }));
  const route = $derived(page.url.pathname);
  const pageTitle = $derived(resolvePageTitle(route, widgetRoutes));

  let open = $state(false);
</script>

<button
  type="button"
  class="page-ticket-btn"
  onclick={() => (open = true)}
  title="Suggest a change to this page"
  aria-label="Suggest a change to this page"
>
  <MessageSquarePlus size={16} aria-hidden="true" />
  <span class="label">Change something</span>
</button>

<!-- Keyed to the route so a half-written draft never carries over to the next page. -->
{#key route}
  <TicketComposeModal
    {open}
    surface={{ kind: 'page', pageTitle, route }}
    label={pageTitle}
    placeholder={`What should change about the ${pageTitle} page?`}
    onClose={() => (open = false)}
  />
{/key}

<style lang="scss" src="./PageTicketButton.scss"></style>
