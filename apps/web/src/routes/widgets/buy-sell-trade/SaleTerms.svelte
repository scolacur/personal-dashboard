<script lang="ts">
  import Button from '$lib/Button.svelte';
  import { saveTerms } from '$lib/buy-sell-trade/api';

  // Standing sale terms, out of the page flow entirely (PD-475 C2).
  //
  // Not a section in the document order: they are edited a few times a year but need to be
  // reachable from anywhere on a long page, which is exactly what a fixed affordance is for.
  // Collapsed by default; expands upward.
  let { terms = $bindable() }: { terms: string } = $props();

  let open = $state(false);
  let draft = $state(terms);
  let saving = $state(false);
  let error = $state('');

  const dirty = $derived(draft !== terms);

  function toggle(): void {
    // Reset the draft when opening, so an abandoned edit does not linger into the next visit.
    if (!open) draft = terms;
    open = !open;
    error = '';
  }

  /** Escape closes. Deliberately no focus trap — this is a panel on the page, not a modal, and
   *  trapping focus in something that never blocks the page behind it is a way to strand people. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      open = false;
    }
  }

  async function save(): Promise<void> {
    saving = true;
    error = '';
    try {
      const saved = await saveTerms(draft);
      terms = saved.terms;
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save terms';
    } finally {
      saving = false;
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="sale-terms" class:open>
  {#if open}
    <div class="terms-panel">
      <textarea
        class="terms-input"
        rows="8"
        aria-label="Sale terms"
        bind:value={draft}
        disabled={saving}
      ></textarea>
      {#if error}<p class="terms-error" role="alert">{error}</p>{/if}
      <div class="terms-actions">
        {#if dirty}<span class="terms-unsaved">Unsaved changes</span>{/if}
        <Button variant="primary" onclick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  {/if}

  <button class="terms-tab" type="button" aria-expanded={open} onclick={toggle}>
    <span class="terms-chevron" aria-hidden="true">{open ? '▾' : '▴'}</span>
    Sale terms
  </button>
</div>

<style lang="scss" src="./SaleTerms.scss"></style>
