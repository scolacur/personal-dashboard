<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { EpicRollbackPlan } from '../epic-drag';

  /**
   * Pulling an Epic back from Queue to Backlog when the cascade would leave members behind
   * (D-TMP-PD383a, PD-508 slice B). Never shown when there is nothing to leave behind — that drag is
   * silent and instant.
   *
   * The one question is about the **parked** members. A member with a live session is reported,
   * not offered: the loop awaits each session with no cancel channel, and D-046 holds that killing
   * a Robot mid-hand-off loses the work outright. A button claiming to stop it would be a lie.
   */
  let {
    epic,
    plan,
    onCancel,
    onRollback,
  }: {
    /** The Epic being rolled back; null closes the modal. */
    epic: AgentTicket | null;
    plan: EpicRollbackPlan;
    onCancel: () => void;
    /** `pullBackParked` also returns the parked members to Backlog. */
    onRollback: (pullBackParked: boolean) => void;
  } = $props();

  const label = (t: AgentTicket) => t.displayId ?? t.title;
</script>

<Modal open={epic !== null} title="Pull this Epic back to Backlog?" onClose={onCancel}>
  {#if epic}
    <p class="rollback-msg">
      <strong>{label(epic)}</strong> goes back to Backlog.
      {#if plan.unqueued.length > 0}
        {plan.unqueued.length} member{plan.unqueued.length === 1 ? '' : 's'} that hadn't started
        {plan.unqueued.length === 1 ? 'comes' : 'come'} with it.
      {:else}
        No member is waiting to start.
      {/if}
    </p>

    {#if plan.running.length > 0}
      <div class="rollback-group running">
        <p class="group-head">
          Still running — {plan.running.length === 1 ? 'this one keeps' : 'these keep'} going
        </p>
        <ul>
          {#each plan.running as m (m.id)}
            <li><strong>{label(m)}</strong> — {m.title}</li>
          {/each}
        </ul>
        <p class="group-note">
          A run in progress can't be stopped from the board: the loop works through one session at a
          time and waits for it to finish, and ending one mid-hand-off throws the work away rather
          than saving it (D-046). {plan.running.length === 1 ? 'It' : 'They'} will land normally —
          the Epic keeps reading <em>In Progress</em> until then.
        </p>
      </div>
    {/if}

    {#if plan.parked.length > 0}
      <div class="rollback-group parked">
        <p class="group-head">
          Parked mid-flight — nothing is running for {plan.parked.length === 1 ? 'this' : 'these'}
        </p>
        <ul>
          {#each plan.parked as m (m.id)}
            <li>
              <strong>{label(m)}</strong> — {m.title}
              {#if m.agentState}<span class="state">{AGENT_STATE_LABELS[m.agentState]}</span>{/if}
            </li>
          {/each}
        </ul>
        <p class="group-note">
          Safe to pull back with the Epic. Leave them if you're only shelving the Epic briefly and
          want to pick these up where they stopped.
        </p>
      </div>
    {/if}

    <div class="rollback-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      {#if plan.parked.length > 0}
        <Button variant="ghost" onclick={() => onRollback(false)}>Leave them in the Queue</Button>
        <Button variant="primary" onclick={() => onRollback(true)}>
          Pull back {plan.parked.length} too
        </Button>
      {:else}
        <Button variant="primary" onclick={() => onRollback(false)}>Move the Epic back</Button>
      {/if}
    </div>
  {/if}
</Modal>

<style lang="scss">
  .rollback-msg {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .rollback-group {
    margin-bottom: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius);
    background: var(--surface-2);
    border-left: 3px solid var(--border);

    &.running {
      border-left-color: var(--accent);
    }

    ul {
      margin: 0 0 var(--space-sm);
      padding-left: var(--space-lg);
      font-size: var(--font-size-sm);
      color: var(--text);
    }

    li {
      margin-bottom: var(--space-xs);
    }
  }

  .group-head {
    margin: 0 0 var(--space-sm);
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .group-note {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--muted);
    line-height: 1.5;
  }

  .state {
    margin-left: var(--space-xs);
    font-size: var(--font-size-xs);
    color: var(--muted);
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
</style>
