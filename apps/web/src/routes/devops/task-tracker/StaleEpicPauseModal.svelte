<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { StaleInvalidationPlan } from '../epic-members';

  /**
   * PD-611 / D-089: adding a member to a **refined, running** Epic is about to un-refine it and
   * return its armed members to Backlog. This asks about the second part only.
   *
   * **The un-refine itself is not offered as a choice.** D-089 §3 settled that: un-refining wrongly
   * costs one click of ✓ Mark refined and is visible, while leaving something refined wrongly is
   * silent and permanent, so a prompt would trade a cheap self-correcting error for an invisible
   * one. What is genuinely worth confirming is that *other tickets are about to leave the Queue* —
   * a consequence for work the human was not thinking about when they added one ticket.
   *
   * Neither action can leave the Epic looking refined when it is not; Cancel backs out the whole
   * thing. The choice is only about how much work stops.
   */
  let {
    plan,
    epicTitle,
    onCancel,
    onPause,
    onKeepRunning,
  }: {
    /** The planned invalidation; null closes the modal. */
    plan: StaleInvalidationPlan | null;
    epicTitle: string;
    onCancel: () => void;
    onPause: () => void;
    onKeepRunning: () => void;
  } = $props();
</script>

<Modal open={plan !== null} title="This will pause the Epic" onClose={onCancel}>
  {#if plan !== null}
    <p class="stale-msg">
      <strong>{epicTitle}</strong> is refined, so its description claims the current members are the
      agreed breakdown of the work. Adding one falsifies that, and the Epic will be marked
      <strong>needing re-refinement</strong> either way.
    </p>
    <p class="stale-msg">
      {plan.unarmed.length}
      {plan.unarmed.length === 1 ? 'member' : 'members'} will return to Backlog so nothing new
      dispatches against a description that no longer covers it.
    </p>
    <ul class="stale-list">
      {#each plan.unarmed as m (m.id)}
        <li><span class="stale-ref">{m.displayId}</span> {m.title}</li>
      {/each}
    </ul>
    {#if plan.inFlight.length > 0}
      <!-- D-046: a run cannot be interrupted, and pulling an `in-review` ticket out of the Queue
           strands the open PR its watcher is scoped to. Named explicitly so a row still showing
           `working` afterwards does not read as the pause having failed. -->
      <p class="stale-msg stale-inflight">
        {plan.inFlight.length}
        {plan.inFlight.length === 1 ? 'member is' : 'members are'} already running and will be left to
        finish: {plan.inFlight.map((m) => m.displayId).join(', ')}.
      </p>
    {/if}
    <div class="stale-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="ghost" onclick={onKeepRunning}>Add &amp; keep running</Button>
      <Button variant="primary" onclick={onPause}>Add &amp; pause the Epic</Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .stale-msg {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .stale-inflight {
    color: var(--muted);
  }

  .stale-list {
    margin: 0 0 var(--space-lg);
    padding-left: var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--muted);
    max-height: 30vh;
    overflow-y: auto;
  }

  .stale-ref {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .stale-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }
</style>
