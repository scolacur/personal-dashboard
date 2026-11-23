<!-- E2E Canary: the throwaway widget the E2E loop test builds into (PD-892).
     The test's reset restores this file to this baseline. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { CHECKING, healthView, type HealthView } from './health-status';

  // PD-937: a health status panel, so a visible change on this page can be photographed.
  let health = $state<HealthView>(CHECKING);

  onMount(async () => {
    let body: unknown = undefined;
    try {
      const res = await fetch('/api/widgets/e2e-canary/health');
      if (res.ok) body = await res.json();
    } catch {
      body = undefined;
    }
    health = healthView(body);
  });
</script>

<h1>E2E Canary</h1>
<p>Test surface. Contents here are built and removed by the E2E loop test.</p>

<section class="health" aria-live="polite">
  <span class="name">Server health</span>
  <span class="badge {health.tone}">{health.label}</span>
</section>

<style lang="scss">
  .health {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
    max-width: 28rem;
    margin-top: var(--space-md);
    padding: var(--space-md);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .name {
    font-size: var(--font-size-base);
    color: var(--text);
  }

  .badge {
    padding: var(--space-xs) var(--space-sm);
    border-radius: 999px;
    font-size: var(--font-size-sm);
    font-weight: 600;
    border: 1px solid currentColor;

    &.neutral {
      color: var(--muted);
    }
    &.ok {
      color: var(--status-done);
    }
    &.bad {
      color: var(--status-stuck);
    }
  }
</style>
