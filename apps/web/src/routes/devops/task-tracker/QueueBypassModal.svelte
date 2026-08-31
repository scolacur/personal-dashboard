<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';

  /**
   * D-058 / PD-399: queueing an unformatted robot ticket needs an explicit acknowledgement.
   * Confirming sets `readyBypassed` — an honest override that never fakes `ready`.
   *
   * PD-591: the copy says "formatted", not "Ready". The flag is about the body carrying the four
   * sections; "Ready" reads as "ready to be worked on", which is a different claim and the one a
   * reader assumes.
   */
  let {
    label,
    onCancel,
    onConfirm,
  }: {
    /** The ticket's display id (or title); null closes the modal. */
    label: string | null;
    onCancel: () => void;
    onConfirm: () => void;
  } = $props();
</script>

<Modal open={label !== null} title="Queue an unformatted ticket?" onClose={onCancel}>
  {#if label !== null}
    <p class="queue-confirm-msg">
      <strong>{label}</strong> isn't formatted — its body is missing the four sections
      (## Context / ## Task / ## Done When / ## Out of scope). The Robot works best from a formatted
      ticket, so <strong>output may be suboptimal</strong>. Queue it anyway?
    </p>
    <div class="queue-confirm-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="primary" onclick={onConfirm}>Queue anyway</Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .queue-confirm-msg {
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .queue-confirm-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }
</style>
