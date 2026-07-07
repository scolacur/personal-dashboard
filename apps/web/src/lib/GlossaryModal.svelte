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

  export type GlossaryTab = 'priority' | 'refinement' | 'sortie';

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
      'Finish the changes manually — push commits to the sortie/<id> branch to complete the work.',
      "Re-scope or split the ticket if it's too big, then re-queue the smaller pieces.",
      'Give clearer / updated feedback and re-trigger Sortie to try again.',
      "Merge the PR as-is if it's acceptable, or close it wontfix.",
    ],
    stuck: [
      'Open the sortie/<id> branch / PR (if one exists) and check how far the run got.',
      "Read the last run's logs/output to find where it stalled (env error, ambiguity, or a loop).",
      'Fix the blocker or clarify the issue, then remove sortie:stuck and re-apply sortie:queued to retry.',
      "If it's too big or ambiguous, re-scope / split it into smaller issues and re-queue those.",
      "If it isn't worth continuing, close it sortie:wontfix.",
    ],
    'awaiting-human': [
      "Read the agent's ask_human question (posted as an issue comment).",
      'Answer it so the worker can resume (per the ask-human reply flow).',
      'If the question exposes missing scope, edit the issue body to add the needed detail.',
      "If it's blocked on an external decision, leave it parked until you can decide.",
      'If the answer is "don\'t proceed", close it sortie:wontfix.',
    ],
  };

  function agentStateClass(s: AgentState): string {
    return `agent-state-${s}`;
  }

  $effect(() => {
    if (!open || activeTab !== 'sortie' || !highlightState) return;
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
      class:active={activeTab === 'sortie'}
      type="button"
      onclick={() => (activeTab = 'sortie')}
    >Sortie Statuses</button>
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
        <span class="refine-pill refine-grilling">{REFINE_STATE_LABELS['grilling']}</span>
        <span class="legend-desc">{REFINE_STATE_DESCRIPTIONS['grilling']}</span>
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
  {:else if activeTab === 'sortie'}
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
        href="https://github.com/scolacur/personal-dashboard/blob/main/docs/sortie.md"
        target="_blank"
        rel="noreferrer">Sortie integration wiki</a
      > for the full loop, the watchdog (stuck detection), and the ask_human flow.
    </p>
  {/if}
</Modal>

<style lang="scss" src="./GlossaryModal.scss"></style>
