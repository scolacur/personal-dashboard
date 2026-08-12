<script lang="ts">
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import { saveTerms } from '$lib/buy-sell-trade/api';

  // Standing sale terms, at the top of the Lists tab.
  //
  // **Back in the page flow.** PD-475 C2 made this a fixed bottom tab because the terms had to be
  // reachable from anywhere on one very long page. The page is now tabbed, and the terms belong
  // to the same tab as the list they describe — so "reachable from anywhere" stopped being a
  // requirement, and a floating affordance that overlapped content stopped being worth its cost
  // (it also forced the page to reserve bottom padding it no longer needs).
  let { terms = $bindable() }: { terms: string } = $props();

  let draft = $state(terms);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state('');

  const dirty = $derived(draft !== terms);

  /** Reset the draft on open, so an abandoned edit does not linger into the next visit. */
  function onToggle(next: boolean): void {
    if (next) draft = terms;
    error = '';
    saved = false;
  }

  async function save(): Promise<void> {
    saving = true;
    error = '';
    try {
      // Saving used to collapse the panel, which was the confirmation. The panel's open state
      // belongs to Collapsible now, so say it instead of showing it — feedback that is only the
      // absence of a "Save" button is not feedback.
      terms = (await saveTerms(draft)).terms;
      saved = true;
      setTimeout(() => (saved = false), 2500);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save terms';
    } finally {
      saving = false;
    }
  }
</script>

<section class="sale-terms">
  <Collapsible title="Sale terms" storeKey="bst-terms" open={false} onToggle={onToggle}>
    <div class="terms-panel">
      <p class="terms-help">
        Appended to every drafted post, under the item list. Edited a few times a year.
      </p>
      <textarea
        class="terms-input"
        rows="8"
        aria-label="Sale terms"
        bind:value={draft}
        disabled={saving}
      ></textarea>
      {#if error}<p class="terms-error" role="alert">{error}</p>{/if}
      <div class="terms-actions">
        {#if dirty}
          <span class="terms-unsaved">Unsaved changes</span>
        {:else if saved}
          <span class="terms-saved" role="status">Saved</span>
        {/if}
        <Button variant="primary" onclick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  </Collapsible>
</section>

<style lang="scss" src="./SaleTerms.scss"></style>
