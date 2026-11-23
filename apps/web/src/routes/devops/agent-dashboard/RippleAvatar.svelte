<script lang="ts">
  // PD-819: the "signal" avatar family — a solid shape per kind (Robot square, Evaluator circle,
  // Auditor diamond) with a different live-activity motion per variant.
  import type { ActiveAgentKind } from '@dashboard/shared';
  import type { RippleStyle } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    style: RippleStyle;
  }
  let { kind, style }: Props = $props();
</script>

{#if style === 'ripple'}
  <circle class="ring" cx="32" cy="26" r="13" />
  <circle class="ring late" cx="32" cy="26" r="13" />
{:else if style === 'sonar'}
  <circle class="track" cx="32" cy="26" r="18" />
  <g class="sweep">
    <path d="M32 8 A18 18 0 0 1 47.6 17" class="arc" />
  </g>
{:else if style === 'halo'}
  <circle class="halo" cx="32" cy="26" r="18" />
{:else if style === 'heartbeat'}
  <circle class="beat-glow" cx="32" cy="26" r="15" />
{:else}
  <g class="orbit">
    <circle cx="32" cy="8" r="2.4" class="sat" />
    <circle cx="47.6" cy="35" r="2.4" class="sat" />
    <circle cx="16.4" cy="35" r="2.4" class="sat" />
  </g>
{/if}

<g class="core-wrap" class:beat={style === 'heartbeat'}>
  {#if kind === 'robot'}
    <rect x="22" y="16" width="20" height="20" rx="5" class="core" />
  {:else if kind === 'evaluator'}
    <circle cx="32" cy="26" r="11" class="core" />
  {:else}
    <rect x="24" y="18" width="16" height="16" rx="2" class="core diamond" />
  {/if}
</g>
