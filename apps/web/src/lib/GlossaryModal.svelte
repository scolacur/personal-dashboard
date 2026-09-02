<script lang="ts">
  import type { AgentState } from '@dashboard/shared';
  import {
    TICKET_PRIORITIES,
    PRIORITY_LABELS,
    PRIORITY_DESCRIPTIONS,
    REFINE_STATE_LABELS,
    REFINE_STATE_DESCRIPTIONS,
    AGENT_STATE_LABELS,
    AGENT_STATE_DESCRIPTIONS,
  } from '@dashboard/shared';
  import Modal from './Modal.svelte';

  export type GlossaryTab = 'priority' | 'refinement' | 'robot';

  let {
    open,
    tab,
    highlightState = null,
    onClose,
  }: {
    open: boolean;
    tab: GlossaryTab;
    highlightState?: AgentState | null;
    onClose: () => void;
  } = $props();

  let activeTab = $state<GlossaryTab>('priority');

  $effect(() => {
    if (open) activeTab = tab;
  });

  const AGENT_STATE_ORDER: AgentState[] = [
    'queued',
    'working',
    'in-review',
    'stuck',
    'needs-human',
    'awaiting-human',
    'wontfix',
    'done',
  ];

  const AGENT_STATE_ACTIONS: Partial<Record<AgentState, string[]>> = {
    // PD-536: these used to describe working through "Request changes" feedback, which is a
    // different situation entirely — the loop handles review feedback by itself, unboundedly
    // (`decideReactivation`). This state means someone CLOSED the PR without merging, so the
    // question is what to do about a rejected attempt.
    'needs-human': [
      'Open the closed PR and check why it was closed rather than merged.',
      'If the approach was wrong, edit the ticket to say so, then Unstick it to have Robot retry.',
      'If the work was fine but the PR went stale, reopen it or re-push the branch yourself.',
      "Re-scope or split the ticket if it's too big, then re-queue the smaller pieces.",
      "If it shouldn't be attempted again, close the ticket wontfix.",
    ],
    stuck: [
      'Open the robot/<issue> branch / PR (if one exists) and check how far the run got.',
      "Read the last run's logs/output to find where it stalled (env error, ambiguity, or a loop).",
      'Fix the blocker or clarify the ticket, then Unstick it to re-queue and retry.',
      "If it's too big or ambiguous, re-scope / split it into smaller tickets and re-queue those.",
      "If it isn't worth continuing, close it as wontfix.",
    ],
    'awaiting-human': [
      "Read the agent's ask_human question (shown inline on the ticket).",
      'Answer it inline so the Robot loop can resume the run.',
      'If the question exposes missing scope, edit the ticket body to add the needed detail.',
      "If it's blocked on an external decision, leave it parked until you can decide.",
      'If the answer is "don\'t proceed", close it as wontfix.',
    ],
  };

  function agentStateClass(s: AgentState): string {
    return `agent-state-${s}`;
  }

  $effect(() => {
    if (!open || activeTab !== 'robot' || !highlightState) return;
    const target = highlightState;
    const timer = setTimeout(() => {
      document.getElementById(`glossary-state-${target}`)?.scrollIntoView({ block: 'nearest' });
    }, 50);
    return () => clearTimeout(timer);
  });
</script>

<Modal {open} title="Glossary" {onClose}>
  <div class="glossary-tabs">
    <button
      class="glossary-tab"
      class:active={activeTab === 'priority'}
      type="button"
      onclick={() => (activeTab = 'priority')}
    >Priority Levels</button>
    <button
      class="glossary-tab"
      class:active={activeTab === 'refinement'}
      type="button"
      onclick={() => (activeTab = 'refinement')}
    >Refinement Statuses</button>
    <button
      class="glossary-tab"
      class:active={activeTab === 'robot'}
      type="button"
      onclick={() => (activeTab = 'robot')}
    >Robot Statuses</button>
  </div>

  {#if activeTab === 'priority'}
    <ul class="priority-legend">
      {#each TICKET_PRIORITIES as p (p)}
        <li>
          <span class="priority priority-{p}">{p}</span>
          <span class="legend-label">{PRIORITY_LABELS[p]}</span>
          <span class="legend-desc">{PRIORITY_DESCRIPTIONS[p]}</span>
        </li>
      {/each}
      <li>
        <span class="priority priority-none">—</span>
        <span class="legend-label">None</span>
        <span class="legend-desc">Priority not set.</span>
      </li>
    </ul>
  {:else if activeTab === 'refinement'}
    <ul class="refinement-legend">
      <li>
        <span class="refine-pill refine-refining">{REFINE_STATE_LABELS['refining']}</span>
        <span class="legend-desc">{REFINE_STATE_DESCRIPTIONS['refining']}</span>
      </li>
      <li>
        <span class="refine-pill refine-awaiting-human">{REFINE_STATE_LABELS['awaiting-human']}</span>
        <span class="legend-desc">{REFINE_STATE_DESCRIPTIONS['awaiting-human']}</span>
      </li>
      <li>
        <span class="refined-mark">✓ Refined</span>
        <span class="legend-desc">
          This ticket has been fully refined and is ready for dispatch. On an <strong>Epic</strong> it
          claims two things: the description frames the work, <em>and</em> the current member set is
          the agreed breakdown of it.
        </span>
      </li>
      <!-- PD-611/D-089: the third state. Listed last because it is the one a reader arrives here
           to look up — it appears without anyone having done anything to the Epic itself, so
           "why does this say Stale when I only added a ticket?" is the question being asked. -->
      <li>
        <span class="refine-pill refine-stale">⚠ Stale</span>
        <span class="legend-desc">
          <strong>Epics only.</strong> It was refined, but its members have changed since — so the
          second half of that claim no longer holds and the flag was cleared automatically. Joining,
          leaving, re-parenting and archiving a member all trigger it; a member simply
          <em>finishing</em> does not, because that is the plan succeeding rather than changing.
          Re-refine, or press <strong>✓ Mark refined</strong> if you have read it and the breakdown
          still stands. A stale Epic and its members cannot be queued until then.
        </span>
      </li>
      <li>
        <span class="legend-label">Paused</span>
        <span class="legend-desc">
          What happens when an Epic goes stale <em>while it is running</em>: its armed members return
          to Backlog so no new work is dispatched against a description that no longer covers it. A
          member already mid-run is left to finish — a run cannot be interrupted. The Epic itself
          stays in the Queue. Marking it refined re-arms everything.
        </span>
      </li>
    </ul>
  {:else if activeTab === 'robot'}
    <ul class="status-legend">
      {#each AGENT_STATE_ORDER as state (state)}
        {@const actions = AGENT_STATE_ACTIONS[state]}
        <li
          id="glossary-state-{state}"
          class:status-legend-highlighted={state === highlightState}
        >
          <div class="status-legend-header">
            <span class="agent-state-badge {agentStateClass(state)}">{AGENT_STATE_LABELS[state]}</span>
          </div>
          <p class="status-legend-desc">{AGENT_STATE_DESCRIPTIONS[state]}</p>
          {#if actions}
            <div class="status-legend-actions">
              <p class="status-legend-actions-title">Recommended actions</p>
              <ol>
                {#each actions as action, i (i)}
                  <li>{action}</li>
                {/each}
              </ol>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="status-legend-more">
      See the <a
        href="https://github.com/scolacur/personal-dashboard/blob/main/docs/robot.md"
        target="_blank"
        rel="noreferrer">Robot integration wiki</a
      > for the full loop, the watchdog (stuck detection), and the ask_human flow.
    </p>
  {/if}
</Modal>

<style lang="scss" src="./GlossaryModal.scss"></style>
