<script lang="ts">
  // PD-819: the Orbit avatar — a solid shape per kind (Robot square, Evaluator circle, Auditor
  // diamond) with three dots circling it.
  import type { ActiveAgentKind } from '@dashboard/shared';

  interface Props {
    kind: ActiveAgentKind;
  }
  let { kind }: Props = $props();
</script>

<g class="orbit">
  <circle cx="32" cy="8" r="2.4" class="sat" />
  <circle cx="47.6" cy="35" r="2.4" class="sat" />
  <circle cx="16.4" cy="35" r="2.4" class="sat" />
</g>

{#if kind === 'robot'}
  <rect x="22" y="16" width="20" height="20" rx="5" class="core" />
{:else if kind === 'evaluator'}
  <circle cx="32" cy="26" r="11" class="core" />
{:else}
  <rect x="24" y="18" width="16" height="16" rx="2" class="core diamond" />
{/if}
