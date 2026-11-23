<script lang="ts">
  import type { BreakerFailureView } from '@dashboard/shared';
  import { faultSignatureLabel } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';

  /**
   * PD-921: why the loop paused itself. The circuit breaker (D-107) stops ALL dispatch after N
   * different tickets in a row fail in a way a retry won't fix — a sign the cause is shared (a
   * broken main, a setup fault) rather than one ticket's problem. The nav label alone could not
   * say that, or which tickets, or what to do next.
   */
  let {
    failures,
    since,
    open,
    resuming,
    onClose,
    onResume,
  }: {
    failures: BreakerFailureView[];
    /** When the pause was set, unix ms. */
    since: number | null;
    open: boolean;
    resuming: boolean;
    onClose: () => void;
    onResume: () => void;
  } = $props();

  const when = $derived(
    since === null
      ? null
      : new Date(since).toLocaleString(undefined, {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }),
  );
</script>

<Modal {open} title="Loop paused itself" {onClose}>
  <p class="bk-msg">
    {failures.length} different tickets in a row failed in a way a retry won't fix{#if when}, the last at
      {when}{/if}. When that happens the cause is usually shared — a broken main, a setup fault, an
    expired credential — so the loop stops dispatching rather than burn through the rest of the Queue
    the same way.
  </p>

  <ul class="bk-list">
    {#each failures as f (f.ticketId)}
      <li>
        {#if f.displayId}
          <a href="/devops/tickets/{f.displayId}" onclick={onClose}>{f.displayId}</a>
        {/if}
        <span class="bk-title">{f.title}</span>
        <span class="bk-why">{faultSignatureLabel(f.signature)}</span>
      </li>
    {/each}
  </ul>

  <p class="bk-note">
    Check whether these share a cause and fix it, then turn the loop back on. The failed tickets stay
    parked; turning the loop on doesn't retry them.
  </p>

  <div class="bk-actions">
    <Button variant="ghost" onclick={onClose}>Close</Button>
    <span class="spacer"></span>
    <Button variant="primary" onclick={onResume} disabled={resuming}>
      {resuming ? 'Turning on…' : 'Turn loop back on'}
    </Button>
  </div>
</Modal>

<style lang="scss">
  .bk-msg,
  .bk-note {
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
    white-space: normal;
  }

  .bk-note {
    font-size: var(--font-size-xs);
    color: var(--muted);
  }

  .bk-list {
    margin: 0 0 var(--space-lg);
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    white-space: normal;

    li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.4rem;
      padding: var(--space-sm) var(--space-md);
      background: var(--surface-2);
      border-left: 3px solid var(--status-stuck);
      border-radius: var(--radius);
      font-size: var(--font-size-sm);
    }

    a {
      font-weight: 600;
    }
  }

  .bk-title {
    color: var(--text);
  }

  .bk-why {
    flex-basis: 100%;
    font-size: var(--font-size-xs);
    color: var(--muted);
  }

  .bk-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);

    .spacer {
      flex: 1;
    }
  }
</style>
