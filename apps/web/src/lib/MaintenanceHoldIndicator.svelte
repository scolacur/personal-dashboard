<script lang="ts">
  import { onMount } from 'svelte';
  import { Wrench } from 'lucide-svelte';
  import { fetchMaintenanceStatus, type MaintenanceStatus } from './maintenance-api';

  // Nav indicator for an open maintenance hold (PD-498).
  //
  // Rides the same Dev Ops predicate as the killswitch and deploy readout: a hold is section-wide
  // operational state, and it explains something a reader would otherwise find alarming — the
  // Robot loop sitting idle with a full queue. Renders nothing at all when no hold is pending, so
  // it costs no nav space in the normal case.

  const POLL_MS = 5000;

  let status = $state<MaintenanceStatus | null>(null);

  onMount(() => {
    const load = async () => {
      try {
        status = await fetchMaintenanceStatus();
      } catch {
        status = null; // a failed poll is not worth a nav-level error
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  });

  // NOT named `state` — that shadows the `$state` rune and breaks every rune in the file.
  const holdState = $derived(status?.active ? 'active' : status?.queued ? 'queued' : null);
</script>

{#if holdState}
  <a
    class="hold-indicator hold-indicator--{holdState}"
    href="/devops/jobs#maintenance-holds"
    title={holdState === 'active'
      ? 'A maintenance hold is open — Robot dispatch is paused while maintenance jobs run.'
      : 'A maintenance hold is queued — it opens once the running Robots finish.'}
  >
    <Wrench size={14} />
    <span>{holdState === 'active' ? 'Maintenance hold' : 'Hold queued'}</span>
  </a>
{/if}

<style lang="scss" src="./MaintenanceHoldIndicator.scss"></style>
