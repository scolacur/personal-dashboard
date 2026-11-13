<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { EpicJoinChoice, EpicJoinPlan } from './epic-join';

  /**
   * PD-703 / D-089: a ticket is about to join a **refined** Epic. One modal for every add path, and
   * for both questions that add raises (it replaces PD-611's `StaleEpicPauseModal`, so a refined,
   * running Epic never stacks two dialogs).
   *
   * **The un-refine is not a choice.** D-089 §3: un-refining wrongly costs one click of ✓ Mark
   * refined and is visible, while leaving something refined wrongly is silent and permanent. So
   * both actions add the ticket and un-refine the Epic; they differ only in whether a Refine session
   * follows. Cancel adds nothing.
   *
   * The pause (PD-611) is asked about only when other tickets would visibly leave the Queue, as a
   * checkbox on the same modal rather than a second dialog.
   */
  let {
    plan,
    joining,
    busy = false,
    onCancel,
    onChoose,
  }: {
    /** The planned join; null closes the modal. */
    plan: EpicJoinPlan | null;
    /** What is being added: a display id, or a draft's title. */
    joining: string;
    busy?: boolean;
    onCancel: () => void;
    onChoose: (choice: EpicJoinChoice) => void;
  } = $props();

  let keepRunning = $state(false);
  $effect(() => {
    // A fresh plan starts from the safe default: pause (PD-611's primary action).
    if (plan) keepRunning = false;
  });

  const epicLabel = $derived(plan ? (plan.epic.displayId ?? plan.epic.title) : '');
</script>

<Modal open={plan !== null} title="This Epic is refined" onClose={onCancel}>
  {#if plan !== null}
    <p class="join-msg">
      <strong>{epicLabel}</strong> is refined: its description claims the current members are the
      agreed breakdown of the work. Adding <strong>{joining}</strong> will <strong>un-refine it</strong>,
      whichever you choose.
    </p>
    <p class="join-msg join-muted">
      <strong>Add &amp; re-refine</strong> adds it, then opens a Refine session on the Epic so its
      description can take in the new member. Approving that session marks the Epic refined again.
    </p>

    {#if plan.pause.needsConfirm}
      <p class="join-msg">
        The Epic is running. Un-refining it returns
        {plan.pause.unarmed.length}
        {plan.pause.unarmed.length === 1 ? 'member' : 'members'} to Backlog, so nothing new dispatches
        against a description that no longer covers it:
      </p>
      <ul class="join-list">
        {#each plan.pause.unarmed as m (m.id)}
          <li><span class="join-ref">{m.displayId}</span> {m.title}</li>
        {/each}
      </ul>
      <label class="join-keep">
        <input type="checkbox" bind:checked={keepRunning} disabled={busy} />
        Keep them running instead
      </label>
    {/if}
    {#if plan.pause.inFlight.length > 0}
      <!-- D-046: a run cannot be interrupted. Named so a row still `working` afterwards does not
           read as the pause having failed. -->
      <p class="join-msg join-muted">
        {plan.pause.inFlight.length}
        {plan.pause.inFlight.length === 1 ? 'member is' : 'members are'} already running and will be
        left to finish: {plan.pause.inFlight.map((m) => m.displayId).join(', ')}.
      </p>
    {/if}

    <div class="join-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="ghost" disabled={busy} onclick={() => onChoose({ reRefine: false, keepRunning })}>
        Add &amp; un-refine
      </Button>
      <Button variant="primary" disabled={busy} onclick={() => onChoose({ reRefine: true, keepRunning })}>
        Add &amp; re-refine
      </Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .join-msg {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .join-muted {
    color: var(--muted);
  }

  .join-list {
    margin: 0 0 var(--space-sm);
    padding-left: var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--muted);
    max-height: 30vh;
    overflow-y: auto;
  }

  .join-ref {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .join-keep {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
  }

  .join-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }
</style>
