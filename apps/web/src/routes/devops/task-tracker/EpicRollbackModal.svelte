<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { EpicRollbackPlan } from '../epic-drag';

  /**
   * Shown when an Epic is dragged Queue → Backlog and some of its members have work in flight.
   * It reports what cannot be recalled; it does not offer to stop it, because nothing can — the
   * loop awaits each session with no cancel channel (D-046).
   *
   * Nothing in flight ⇒ this never opens and the drag is silent.
   */
  let {
    epic,
    plan,
    busy = false,
    onCancel,
    onContinue,
    onBump,
  }: {
    /** The Epic being rolled back; null closes the modal. */
    epic: AgentTicket | null;
    plan: EpicRollbackPlan;
    /** A choice is mid-write — both actions take several round trips. */
    busy?: boolean;
    onCancel: () => void;
    onContinue: () => void;
    onBump: () => void;
  } = $props();

  const n = $derived(plan.inFlight.length);
</script>

<Modal
  open={epic !== null}
  title="Some tickets in this epic are actively being worked on"
  onClose={onCancel}
>
  {#if epic}
    <ul class="active-list">
      {#each plan.inFlight as m (m.id)}
        <li>
          <a href="/devops/tickets/{m.displayId}" target="_blank" rel="noreferrer">
            <span class="tid">{m.displayId}</span>
            <span class="ttitle">{m.title}</span>
          </a>
          {#if m.agentState}
            <span class="tstate">{AGENT_STATE_LABELS[m.agentState]}</span>
          {/if}
        </li>
      {/each}
    </ul>

    <p class="rollback-note">
      A run in progress can&rsquo;t be stopped, so either the epic stays in the queue with it, or
      {n === 1 ? 'it moves' : 'they move'} into {n === 1 ? 'its' : 'their'} own epic and this one goes
      back to the backlog.
    </p>

    <div class="rollback-actions">
      <Button variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="ghost" onclick={onBump} disabled={busy}>
        Bump {n === 1 ? 'it' : `all ${n}`} into a new epic &amp; move this one to backlog
      </Button>
      <Button variant="primary" onclick={onContinue} disabled={busy}>Continue</Button>
    </div>

    <p class="rollback-fineprint">
      Clicking &ldquo;Continue&rdquo; will move all of this epic&rsquo;s tickets that are not
      completed, closed, or actively being worked on back to the backlog. The epic will remain in
      the queue.
    </p>
  {/if}
</Modal>

<style lang="scss">
  .active-list {
    margin: 0 0 var(--space-lg);
    padding: 0;
    list-style: none;

    li {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      padding: var(--space-sm) 0;
      border-bottom: 1px solid var(--border);

      &:last-child {
        border-bottom: none;
      }
    }

    a {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      min-width: 0;
      text-decoration: none;

      &:hover .ttitle {
        color: var(--accent);
      }
    }
  }

  .tid {
    flex: 0 0 auto;
    font-family: var(--font-display);
    font-size: var(--font-size-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--accent);
  }

  .ttitle {
    font-size: var(--font-size-sm);
    color: var(--text);
  }

  .tstate {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: var(--font-size-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  .rollback-note {
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .rollback-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }

  // Spells out what the default action does, below the buttons rather than above them — the
  // choice is the point; this is the confirmation of it.
  .rollback-fineprint {
    margin: var(--space-md) 0 0;
    font-size: var(--font-size-xs);
    color: var(--muted);
    line-height: 1.5;
  }
</style>
