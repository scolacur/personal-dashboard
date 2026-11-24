import type { AgentState, AgentRun, TicketEvent, RobotEventDetail } from '@dashboard/shared';
import { AGENT_STATE_DESCRIPTIONS, ROBOT_EVENT, progressCheckLine } from '@dashboard/shared';

/**
 * The "needs you" modal (T900). When a ticket's Robot status pill is in one of the input-needed
 * states, clicking it opens a modal ON THE BOARD — what is stuck, the agent's own words, and the
 * actions for that state — instead of sending the human off to the detail page.
 *
 * This module is the Claude-free, `.svelte`-free core: the per-state REGISTRY plus the pure
 * functions that resolve a ticket's runs + events into what the modal renders. The web test runner
 * only transforms `.ts` (no Svelte plugin — see apps/web/vitest.config.ts), so keeping the content
 * logic here is what makes it testable; `StatusActionModal.svelte` is a thin renderer over it.
 *
 * Adding a state is ONE registry entry — `checkpoint` (PD-737, the turn ceiling is a checkpoint) was
 * the first added this way, with a `status-report` words source and Continue / Restart actions.
 */

/** The remediation a state's button triggers. `open-pr` is a link, not a server call. `continue` /
 *  `restart` answer a checkpoint (D-094). Since PD-964 a Continue starts a fresh episode and takes no
 *  turn count. */
export type StatusActionKind = 'unstick' | 'reset' | 'open-pr' | 'continue' | 'restart';

export interface StatusActionButton {
  kind: StatusActionKind;
  label: string;
}

/** Which of the agent's own words to surface for a state. */
export type AgentWordsSource = 'ask-question' | 'status-report' | 'output-tail';

export interface StatusActionEntry {
  state: AgentState;
  /** Modal heading. */
  title: string;
  /** Plain-words description of what the state means (reused from the shared glossary copy). */
  description: string;
  words: {
    source: AgentWordsSource;
    /** Label shown above the agent's words. */
    label: string;
    /** Collapse the words behind a disclosure — true for long output tails. */
    collapsed: boolean;
    /** Copy shown when there are no words to surface (a missing field falls back gracefully). */
    emptyFallback: string;
  };
  /** Buttons for this state. Empty is valid — `awaiting-human` uses the reply box instead. */
  actions: StatusActionButton[];
  /** Whether the inline answer box is shown (posts a reply that re-queues the Robot). */
  reply: boolean;
}

/**
 * The per-state content registry. Only the input-needed states are present; every other agent
 * state's pill keeps whatever destination it already had (PD-619). `in` on this map is therefore the
 * single source of truth for "does the pill open the modal?".
 */
export const STATUS_ACTION_REGISTRY: Partial<Record<AgentState, StatusActionEntry>> = {
  stuck: {
    state: 'stuck',
    title: 'Stuck — needs you',
    description: AGENT_STATE_DESCRIPTIONS.stuck,
    words: {
      source: 'output-tail',
      label: 'Run output (tail)',
      collapsed: true,
      emptyFallback: 'This run produced no saved output.',
    },
    actions: [
      { kind: 'unstick', label: 'Unstick' },
      { kind: 'reset', label: 'Reset' },
    ],
    reply: false,
  },
  'awaiting-human': {
    state: 'awaiting-human',
    title: 'Awaiting your answer',
    description: AGENT_STATE_DESCRIPTIONS['awaiting-human'],
    words: {
      source: 'ask-question',
      label: 'The Robot asked:',
      collapsed: false,
      emptyFallback: 'The Robot is waiting on a reply (its question was not recorded).',
    },
    actions: [],
    reply: true,
  },
  'needs-human': {
    state: 'needs-human',
    title: 'PR closed unmerged',
    description: AGENT_STATE_DESCRIPTIONS['needs-human'],
    words: {
      source: 'output-tail',
      label: 'Run output (tail)',
      collapsed: true,
      emptyFallback: 'This run produced no saved output.',
    },
    actions: [
      { kind: 'open-pr', label: 'Open PR' },
      { kind: 'reset', label: 'Reset' },
    ],
    reply: false,
  },
  // PD-737 (the turn ceiling is a checkpoint, D-094); PD-964 (the progress check, D-114).
  checkpoint: {
    state: 'checkpoint',
    title: 'Stopped at a progress check',
    description: AGENT_STATE_DESCRIPTIONS.checkpoint,
    words: {
      source: 'status-report',
      label: 'The Robot reported:',
      collapsed: false,
      emptyFallback: 'No status report was recorded for this checkpoint.',
    },
    actions: [
      { kind: 'continue', label: 'Continue' },
      { kind: 'restart', label: 'Restart' },
    ],
    reply: false,
  },
};

/** Does clicking this state's pill open the modal (vs. its PD-619 destination)? */
export function isStatusActionState(state: AgentState | null | undefined): state is AgentState {
  return state != null && state in STATUS_ACTION_REGISTRY;
}

/** The ticket's latest run. Runs arrive newest-first (`GET /tickets/:id/runs`); null when none. */
export function latestRun(runs: AgentRun[]): AgentRun | null {
  return runs.length > 0 ? runs[0] : null;
}

/** Turns summed across every recorded run — the cumulative cost, not just the latest attempt. */
export function cumulativeTurns(runs: AgentRun[]): number {
  return runs.reduce((sum, r) => sum + (r.turns ?? 0), 0);
}

/**
 * Why the ticket is parked, in plain words — mirrors the detail page (PD-395). Scans events
 * newest-first (they arrive oldest-first) for a park cause: a closed-unmerged PR, an explicit park,
 * or a stall. Falls back to the latest run's fault reason so a bare fault still explains itself.
 * Null when nothing is recorded.
 */
export function parkReason(events: TicketEvent[], runs: AgentRun[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = (e.detail ?? {}) as RobotEventDetail;
    if (e.type === ROBOT_EVENT.prClosed) {
      return d.prNumber
        ? `PR #${d.prNumber} was closed without merging.`
        : 'The PR was closed without merging.';
    }
    if (e.type === ROBOT_EVENT.parked) return d.reason ?? 'The run was parked.';
    if (e.type === ROBOT_EVENT.checkpoint) {
      // PD-964: a progress-check park names what stopped it — a tripwire, the judge's verdict and
      // reason, or the total cap. An older (pre-PD-964) checkpoint carries only its reason text.
      if (d.checkedBy) return `Checkpoint — ${progressCheckLine(d)}.`;
      return d.reason ? `Checkpoint: ${d.reason}.` : 'The run reached its turn ceiling.';
    }
    if (e.type === ROBOT_EVENT.stalled) {
      return d.reason ? `Stalled run: ${d.reason}` : 'The run stalled and was parked.';
    }
  }
  return latestRun(runs)?.faultReason ?? null;
}

/** The Robot's outstanding ask_human question (newest `robot_ask_human` event), or null. */
export function askQuestion(events: TicketEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === ROBOT_EVENT.askHuman) {
      const q = (events[i].detail as RobotEventDetail | null)?.question;
      return typeof q === 'string' && q.trim() ? q : null;
    }
  }
  return null;
}

/**
 * The checkpoint's status report (D-094): the latest run's stored report when it is a checkpoint run,
 * else the newest `robot_checkpoint` event's — the event outlives a run row read from an older worker.
 */
export function statusReport(runs: AgentRun[], events: TicketEvent[]): string | null {
  const run = latestRun(runs);
  if (run?.status === 'checkpoint' && run.statusReport?.trim()) return run.statusReport;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === ROBOT_EVENT.checkpoint) {
      const r = (events[i].detail as RobotEventDetail | null)?.report;
      return typeof r === 'string' && r.trim() ? r : null;
    }
  }
  return null;
}

/** Fully-resolved content the modal renders — pure over the registry entry + the ticket's data. */
export interface ResolvedStatusContent {
  title: string;
  description: string;
  /** Why it parked (fault/park reason), or null. */
  reason: string | null;
  /** The agent's own words (question / report / output tail), or null when none were recorded. */
  words: string | null;
  wordsLabel: string;
  wordsCollapsed: boolean;
  /** Copy to show in place of `words` when it is null. */
  wordsFallback: string;
  runCount: number;
  totalTurns: number;
  /** The latest run's PR url, for an `open-pr` action; null when there is none. */
  prUrl: string | null;
  actions: StatusActionButton[];
  reply: boolean;
}

/** Resolve a registry entry against a ticket's runs + events into render-ready content. */
export function buildStatusContent(
  entry: StatusActionEntry,
  runs: AgentRun[],
  events: TicketEvent[],
): ResolvedStatusContent {
  const run = latestRun(runs);
  let words: string | null = null;
  switch (entry.words.source) {
    case 'ask-question':
      words = askQuestion(events);
      break;
    case 'output-tail':
      words = run?.outputTail ?? null;
      break;
    case 'status-report':
      words = statusReport(runs, events);
      break;
  }
  return {
    title: entry.title,
    description: entry.description,
    reason: parkReason(events, runs),
    words,
    wordsLabel: entry.words.label,
    wordsCollapsed: entry.words.collapsed,
    wordsFallback: entry.words.emptyFallback,
    runCount: runs.length,
    totalTurns: cumulativeTurns(runs),
    prUrl: run?.prUrl ?? null,
    actions: entry.actions,
    reply: entry.reply,
  };
}
