<script lang="ts">
  import * as api from '../../api';

  // D-103 (PD-808): switch an Epic out of auto-queue. The promoter never auto-promotes a member of
  // an excluded Epic (`epic-not-excluded` ✗ in the eligibility checklist); manual queueing is
  // unaffected. Set by hand on Robot / Osiris / infra Epics so the loop never queues
  // self-modifying work. Shown on Epics only.
  const {
    ticketId,
    excluded,
    onChanged,
  }: { ticketId: number; excluded: boolean; onChanged: () => void } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function toggle() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await api.updateTicket(ticketId, { autoQueueExcluded: !excluded });
      onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="auto-queue-toggle">
  <label for="auto-queue-toggle-{ticketId}">
    <input
      id="auto-queue-toggle-{ticketId}"
      type="checkbox"
      checked={excluded}
      disabled={busy}
      onchange={toggle}
    />
    <span>Exclude from auto-queue</span>
  </label>
  <span class="auto-queue-hint">
    {#if error}{error}{:else}Members of this Epic are never queued automatically. You can still queue
      them by hand.{/if}
  </span>
</div>

<style lang="scss" src="./AutoQueueToggle.scss"></style>
