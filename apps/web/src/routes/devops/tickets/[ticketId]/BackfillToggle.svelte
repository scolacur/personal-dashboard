<script lang="ts">
  import * as api from '../../api';

  // PD-748: switch an Epic in or out of the Refine backfill. The backfill drips the existing backlog
  // into auto-started Refine sessions; an excluded Epic and its members are skipped (the wishlist
  // Epics for widgets that don't exist yet). Shown on Epics only.
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
      await api.setBackfillExcluded(ticketId, !excluded);
      onChanged();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="backfill-toggle">
  <label for="backfill-toggle-{ticketId}">
    <input id="backfill-toggle-{ticketId}" type="checkbox" checked={!excluded} disabled={busy} onchange={toggle} />
    <span>Auto-refine this Epic's backlog</span>
  </label>
  <span class="backfill-hint">
    {#if error}{error}{:else if excluded}Off: the backfill skips this Epic and its members.{:else}On: its unrefined tickets get Refine sessions in priority order.{/if}
  </span>
</div>

<style lang="scss" src="./BackfillToggle.scss"></style>
