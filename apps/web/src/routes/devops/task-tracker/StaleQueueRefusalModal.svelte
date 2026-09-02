<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { StaleQueueRefusal } from '../board-drag';

  /**
   * PD-611: the drop is **refused**, not offered as an override.
   *
   * This is what makes the pause mean anything. Un-arming a stale Epic's members returns them to
   * Backlog; if they can be dragged straight back, the pause lasts as long as it takes to drag them
   * and the whole mechanism is decorative.
   *
   * Deliberately NOT shaped like `QueueBypassModal` — that one has a "do it anyway" button because
   * D-058's formatting bypass is an honest override someone might want. There is no equivalent here:
   * dispatching against a description that no longer covers the work is not a trade-off, and the
   * remedy is one click on the Epic. So the only actions are "go fix it" and "close".
   *
   * **Interim.** PD-633 ([Board] The queue-refusal modal: a criteria checklist with a route to
   * satisfy each one) replaces this with the general criteria checklist, of which staleness is one
   * row. Kept as its own small component so that swap is a deletion.
   */
  let {
    refusal,
    onClose,
  }: {
    /** The refusal to explain; null closes the modal. */
    refusal: StaleQueueRefusal | null;
    onClose: () => void;
  } = $props();

  const epicHref = $derived(refusal?.epicDisplayId ? `/devops/tickets/${refusal.epicDisplayId}` : null);
</script>

<Modal open={refusal !== null} title="This Epic needs re-refinement first" onClose={onClose}>
  {#if refusal !== null}
    <p class="refusal-msg">
      {#if refusal.bulk}
        <strong>{refusal.epicTitle}</strong> was refined, but its members have changed since — so its
        description no longer covers the work, and it cannot be queued.
      {:else}
        This ticket belongs to <strong>{refusal.epicTitle}</strong>, which was refined and has since
        changed members. Its description no longer covers the work, so its members cannot be queued.
      {/if}
    </p>
    <p class="refusal-msg refusal-remedy">
      Re-refine the Epic, or press <strong>✓ Mark refined</strong> on it if you have read it and the
      breakdown still holds — that also puts any paused members back in the Queue.
    </p>
    <div class="refusal-actions">
      <Button variant="ghost" onclick={onClose}>Close</Button>
      <span class="spacer"></span>
      {#if epicHref}
        <a class="refusal-link" href={epicHref}>Open {refusal.epicDisplayId}</a>
      {/if}
    </div>
  {/if}
</Modal>

<style lang="scss">
  .refusal-msg {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .refusal-remedy {
    margin-bottom: var(--space-lg);
    color: var(--muted);
  }

  .refusal-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }

  .refusal-link {
    padding: var(--space-xs) var(--space-md);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
    font-size: var(--font-size-sm);
    text-decoration: none;

    &:hover {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
  }
</style>
