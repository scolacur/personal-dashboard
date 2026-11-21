<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import QueueEligibilityChecklist from '$lib/QueueEligibilityChecklist.svelte';

  /**
   * The board's "Queue eligibility criteria" reference modal (D-103, PD-810). It lists every
   * per-ticket criterion and capacity limit with its one-line description — rendered from the
   * exported definitions via `QueueEligibilityChecklist` in `definitions` mode (no ✓/✗), so it
   * cannot drift from what the promoter actually judges against. The two lead lines draw the
   * automated/human boundary D-103 settles.
   */
  let { open, onClose }: { open: boolean; onClose: () => void } = $props();
</script>

<Modal {open} title="Queue eligibility criteria" {onClose}>
  <div class="qcm">
    <p class="qcm-line">
      <span class="qcm-tag qcm-auto">Automated</span>
      A refined Backlog ticket is promoted into the Queue on its own once every criterion and
      capacity limit below is satisfied.
    </p>
    <p class="qcm-line">
      <span class="qcm-tag qcm-human">You decide</span>
      Refining a ticket or Epic, activating an Epic (moving it to the Queue), the assignee, bypassing
      Ready, and excluding an Epic from auto-queue all stay manual.
    </p>
    <QueueEligibilityChecklist definitions ticketHref={() => null} />
  </div>
</Modal>

<style lang="scss" src="./QueueCriteriaModal.scss"></style>
