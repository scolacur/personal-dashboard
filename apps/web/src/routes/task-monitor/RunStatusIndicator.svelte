<script lang="ts">
  import type { AuditRunStatus } from '@dashboard/shared';
  import { runStatusLabel } from '$lib/audit-display';

  // Compact run-status glyph for the Jobs cards (PD-286), leftmost column of each run row:
  //  queued  → animated ellipsis (no label)   done → green dot
  //  running → pulsing orange dot              error → red dot
  let { status }: { status: AuditRunStatus } = $props();
</script>

<span class="rsi" role="img" aria-label={runStatusLabel(status)} title={runStatusLabel(status)}>
  {#if status === 'requested'}
    <span class="rsi-ellipsis"><span class="d"></span><span class="d"></span><span class="d"></span></span>
  {:else}
    <span class="rsi-dot rsi-{status}"></span>
  {/if}
</span>

<style lang="scss">
  .rsi {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    flex-shrink: 0;
  }

  .rsi-dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
  }

  .rsi-done {
    background: var(--status-done);
  }

  .rsi-error {
    background: var(--status-stuck);
  }

  .rsi-running {
    background: #f59e0b; // orange
    animation: rsi-pulse 1.2s ease-in-out infinite;
  }

  @keyframes rsi-pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.35;
      transform: scale(0.7);
    }
  }

  .rsi-ellipsis {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;

    .d {
      width: 0.28rem;
      height: 0.28rem;
      border-radius: 50%;
      background: var(--text);
      animation: rsi-blink 1.2s infinite ease-in-out;
    }
    .d:nth-child(2) {
      animation-delay: 0.2s;
    }
    .d:nth-child(3) {
      animation-delay: 0.4s;
    }
  }

  @keyframes rsi-blink {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }
</style>
