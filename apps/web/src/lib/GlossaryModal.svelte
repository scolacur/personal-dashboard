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
    'needs-human': [
      'Read the outstanding "Request changes" review comments on the PR.',
      'Finish the changes manually — push commits to the robot/<issue> branch to complete the work.',
      "Re-scope or split the ticket if it's too big, then re-queue the smaller pieces.",
      'Give clearer / updated feedback and Unstick the ticket to have Robot try again.',
      "Merge the PR as-is if it's acceptable, or close it wontfix.",
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
        <span class="legend-desc">This ticket has been fully refined and is ready for dispatch.</span>
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
