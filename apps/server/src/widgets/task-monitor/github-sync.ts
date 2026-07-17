import type Database from 'better-sqlite3';
import type { AgentState, TicketAssignee, TicketStatus } from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import {
  applyDerivedState,
  createNotification,
  getTicket,
  listQueuedIssueTargets,
  listSyncTargets,
  updateTicket,
} from './store';

// PD-165: derive board status + agent state from a linked issue's `sortie:*` labels
// by polling GitHub (D-020: labels are the state machine, not the Sortie :7678 API).
// Dependency-free HTTP (built-in fetch) so it needs no new package and honours the
// container's HTTPS_PROXY (squid egress). Only READ access is required.

export interface DerivedState {
  status: TicketStatus;
  agentState: AgentState | null;
  /** When present, force this assignee on the ticket. Absent = don't touch. */
  assignee?: TicketAssignee;
}

// Precedence-ordered: first matching label wins (Sortie applies one active state at
// a time, but ordering makes a stray extra label deterministic). Under the D-040
// redesign EVERY non-terminal sortie:* label maps to the single `robot_queue` lane —
// the fine state lives in `agentState` (shown as a card pill). Only 'working' drives
// the shimmer; stuck/needs-human/awaiting-human are paused-need-attention; queued/
// in-review are informational. `assignee: 'robot'` is set where the agent is the owner.
const LABEL_RULES: readonly { label: string; status: TicketStatus; agentState: AgentState | null; assignee?: TicketAssignee }[] = [
  { label: 'sortie:stuck', status: 'robot_queue', agentState: 'stuck', assignee: 'robot' },
  { label: 'sortie:needs-human', status: 'robot_queue', agentState: 'needs-human', assignee: 'robot' },
  { label: 'sortie:awaiting-human', status: 'robot_queue', agentState: 'awaiting-human', assignee: 'robot' },
  { label: 'sortie:in-review', status: 'robot_queue', agentState: 'in-review' },
  { label: 'sortie:in-progress', status: 'robot_queue', agentState: 'working', assignee: 'robot' },
  { label: 'sortie:queued', status: 'robot_queue', agentState: 'queued', assignee: 'robot' },
] as const;

/**
 * Map an issue's labels + open/closed state to a derived (status, agentState[, assignee]),
 * or `null` when no rule applies — meaning "leave the ticket alone" (no sortie:* label yet).
 */
export function deriveState(labels: string[], issueState: 'open' | 'closed'): DerivedState | null {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  // sortie:wontfix is a terminal label that maps to board `closed` regardless of
  // whether the GitHub issue is still open or already closed — checked before the
  // generic closed→completed fallback so it is never swallowed by it.
  if (set.has('sortie:wontfix')) return { status: 'closed', agentState: null };
  // sortie:done is terminal → the `completed` lane, but keeps the 'done' agentState so the
  // card shows a green "done" pill. Checked before the generic closed→completed fallback
  // because a Sortie-completed issue is usually ALSO closed on GitHub; without this the
  // closed branch below would strip the agentState to null and the pill would vanish.
  if (set.has('sortie:done')) return { status: 'completed', agentState: 'done' };
  // Closed is terminal and authoritative: a closed issue is completed regardless of
  // any stale non-terminal label still hanging on it (e.g. an issue closed while it
  // still wore sortie:in-review). Checked before LABEL_RULES so stale labels can't
  // override a closed issue state.
  if (issueState === 'closed') return { status: 'completed', agentState: null };
  // Open issue: derive from its active sortie:* label (precedence-ordered).
  for (const rule of LABEL_RULES) {
    if (set.has(rule.label)) {
      const derived: DerivedState = { status: rule.status, agentState: rule.agentState };
      if (rule.assignee !== undefined) derived.assignee = rule.assignee;
      return derived;
    }
  }
  return null;
}

interface GithubIssue {
  state: 'open' | 'closed';
  labels: { name: string }[];
}

export interface GithubSyncDeps {
  db: Database.Database;
  token: string;
  log: CronLogger;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * One reconciliation pass: for every GitHub-linked ticket, fetch its issue, derive
 * the state, and write it only when it changed. Per-issue failures are logged and
 * skipped so one bad issue never aborts the sweep.
 */
export async function runGithubSync({ db, token, log, fetchImpl = fetch }: GithubSyncDeps): Promise<void> {
  for (const t of listSyncTargets(db)) {
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${t.githubRepo}/issues/${t.githubIssueNumber}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'personal-dashboard-agent-sync',
          },
        },
      );
      if (!res.ok) {
        if (res.status === 404) {
          // PD-207 C: a 404 means the issue was deleted on GitHub. Unlink it (clear the
          // issue number/url) but KEEP the ticket — deletion is ticket-authoritative
          // (D-039). Only 404 unlinks; transient errors (403/5xx) are left to retry.
          updateTicket(db, t.id, { githubIssueNumber: null, githubIssueUrl: null });
          log.info(
            `github-sync: ${t.githubRepo}#${t.githubIssueNumber} 404 (deleted) -> unlinked ticket ${t.id}`,
          );
        } else {
          log.error(`github-sync: ${t.githubRepo}#${t.githubIssueNumber} -> HTTP ${res.status}`);
        }
        continue;
      }
      const issue = (await res.json()) as GithubIssue;
      const issueLabels = (issue.labels ?? []).map((l) => l.name);
      const derived = deriveState(issueLabels, issue.state);
      // Under D-040 every agent-active label (incl. sortie:queued) yields a derived
      // state with the robot assignee, so applyDerivedState covers status + agentState +
      // assignee in one write; a null derived means no sortie:* label → leave the ticket.
      if (derived && applyDerivedState(db, t.id, derived.status, derived.agentState, derived.assignee)) {
        log.info(
          `github-sync: ${t.githubRepo}#${t.githubIssueNumber} -> ${derived.status}/${derived.agentState ?? '-'}`,
        );
      }
      // PD-250 Notification Center: when the ticket NEWLY enters an attention state
      // (awaiting-human / needs-human), surface a notification with the agent's question.
      // `t.agentState` is the pre-poll value, so this fires once per park (dedup in the
      // store backstops it). Best-effort — the status write above has already landed.
      const parkedKind =
        derived?.agentState === 'awaiting-human'
          ? 'agent_awaiting_human'
          : derived?.agentState === 'needs-human'
            ? 'agent_needs_human'
            : null;
      if (parkedKind && t.agentState !== derived!.agentState) {
        const ticket = getTicket(db, t.id);
        const question = await fetchLatestAskHuman(t.githubRepo, t.githubIssueNumber, token, fetchImpl);
        const created = createNotification(db, {
          kind: parkedKind,
          ticketId: t.id,
          title: `${ticket?.displayId ?? `#${t.githubIssueNumber}`} — agent needs you`,
          body: question ?? 'The agent paused and needs your input. Open the ticket to reply.',
        });
        if (created) {
          log.info(`github-sync: ${t.githubRepo}#${t.githubIssueNumber} -> notification (${parkedKind})`);
        }
      }
    } catch (err) {
      log.error(
        `github-sync: ${t.githubRepo}#${t.githubIssueNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * On-demand sync guard (PD-252): the board triggers a reconciliation pass on page load
 * (and via a "Sync now" button) so a just-closed issue shows up without waiting for the
 * once-a-minute cron. This guards that trigger so a burst of refreshes — or many open
 * tabs — can't hammer GitHub's rate limit:
 *   - a pass already running → later callers piggyback on it (coalesce) and resolve when
 *     it lands, so they still re-read fresh data;
 *   - a pass ran within `MIN_ON_DEMAND_INTERVAL_MS` → skip (the DB is already fresh enough).
 * The cron pass runs independently and does not touch this guard.
 */
const MIN_ON_DEMAND_INTERVAL_MS = 10_000;
let onDemandInFlight: Promise<void> | null = null;
let lastOnDemandAt = 0;

export type OnDemandSyncOutcome = 'ran' | 'coalesced' | 'throttled';

export async function requestGithubSync(deps: GithubSyncDeps): Promise<OnDemandSyncOutcome> {
  if (onDemandInFlight) {
    await onDemandInFlight;
    return 'coalesced';
  }
  if (Date.now() - lastOnDemandAt < MIN_ON_DEMAND_INTERVAL_MS) {
    return 'throttled';
  }
  onDemandInFlight = runGithubSync(deps).finally(() => {
    lastOnDemandAt = Date.now();
    onDemandInFlight = null;
  });
  await onDemandInFlight;
  return 'ran';
}

/** Reset the on-demand guard — for tests only, so module state doesn't leak across cases. */
export function __resetOnDemandSyncGuard(): void {
  onDemandInFlight = null;
  lastOnDemandAt = 0;
}

function ghHeaders(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'personal-dashboard-agent-sync',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Post a comment on an issue via the write token (PD-250 inline reply). Returns whether
 * GitHub accepted it — best-effort at the call site. The caller adds the
 * `<!-- sortie:human-reply -->` marker so the sortie-ask-human Action (PD-133) re-queues.
 */
export async function postIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: ghHeaders(token, true),
    body: JSON.stringify({ body }),
  });
  return res.ok;
}

/** The marker line the agent's ask_human question opens with (WORKFLOW.md). */
const ASK_HUMAN_MARKER = '### ❓ ask_human';

/**
 * Best-effort: fetch an issue's comments and return the latest `### ❓ ask_human`
 * question body (with the marker line stripped). Returns null on any failure or when no
 * such comment exists — the caller falls back to a generic notification body.
 */
async function fetchLatestAskHuman(
  repo: string,
  issueNumber: number,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    const comments = (await res.json()) as { body?: string }[];
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i]?.body ?? '';
      if (body.startsWith(ASK_HUMAN_MARKER)) {
        const stripped = body.slice(ASK_HUMAN_MARKER.length).trim();
        return stripped || body.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// The `sortie:*` labels that keep an issue in Sortie's `query_filter` (WORKFLOW.md) and
// therefore make it a dispatch candidate. Stripped on close-on-delete so an archived
// ticket's issue leaves the candidate set regardless of how Sortie handles closed-issue
// state (a closed issue *should* drop out per WORKFLOW.md, but that is an external,
// version-dependent assumption — removing the labels is the belt-and-suspenders guarantee).
const ACTIVE_SORTIE_LABELS = new Set(['sortie:queued', 'sortie:in-progress']);

/**
 * PD-207 A: cancel a linked issue when its ticket is archived — strip the active
 * `sortie:*` labels (so it leaves Sortie's dispatch candidate set) AND close it as
 * "not planned" (state=closed, state_reason=not_planned), in a single PATCH.
 *
 * Reads the current labels first so it can preserve non-sortie labels (GitHub's label
 * PATCH replaces the whole set). If that read fails, it still closes — labels are left
 * untouched rather than accidentally cleared. Returns whether the close PATCH was
 * accepted; the caller treats the whole thing as best-effort. Uses the write-scoped token.
 */
export async function closeIssueNotPlanned(
  repo: string,
  issueNumber: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
  // Read current labels so we can drop only the active sortie:* ones and keep the rest.
  let keepLabels: string[] | undefined;
  const get = await fetchImpl(url, { headers: ghHeaders(token) });
  if (get.ok) {
    const issue = (await get.json()) as GithubIssue;
    keepLabels = (issue.labels ?? [])
      .map((l) => l.name)
      .filter((name) => !ACTIVE_SORTIE_LABELS.has(name.toLowerCase()));
  }
  // Close + (when we could read them) rewrite the label set without the active sortie:* labels.
  const body: Record<string, unknown> = { state: 'closed', state_reason: 'not_planned' };
  if (keepLabels !== undefined) body.labels = keepLabels;
  const res = await fetchImpl(url, {
    method: 'PATCH',
    headers: ghHeaders(token, true),
    body: JSON.stringify(body),
  });
  return res.ok;
}

/** The label Sortie polls for to pick up a ticket. */
const QUEUED_LABEL = 'sortie:queued';

/**
 * PD-164 (board → GitHub, WRITE). For every ticket in the `queued` lane of a
 * sortie-enabled project: ensure its issue exists and carries `sortie:queued`.
 * - Unlinked ticket → create the issue (title+body verbatim) with the label, link back.
 * - Linked ticket with NO `sortie:*` label yet → add `sortie:queued` (covers a
 *   manually-linked issue). If it already has any `sortie:*` label, leave it alone —
 *   Sortie owns the lifecycle transitions from there.
 * Dragging a ticket into Queued therefore gets its issue labelled within one poll.
 */
export async function runQueuedSync({ db, token, log, fetchImpl = fetch }: GithubSyncDeps): Promise<void> {
  for (const t of listQueuedIssueTargets(db)) {
    try {
      if (t.githubIssueNumber == null) {
        // Create + label + link. NOTE: if the process dies between create and the
        // write-back, a re-poll would create a duplicate — accepted (single-user;
        // hand-fixable), same tradeoff as DECISIONS D-029.
        const res = await fetchImpl(`https://api.github.com/repos/${t.githubRepo}/issues`, {
          method: 'POST',
          headers: ghHeaders(token, true),
          body: JSON.stringify({ title: t.title, body: t.body ?? '', labels: [QUEUED_LABEL] }),
        });
        if (!res.ok) {
          log.error(`queued-sync: create ${t.githubRepo} for ticket ${t.id} -> HTTP ${res.status}`);
          continue;
        }
        const issue = (await res.json()) as { number: number; html_url: string };
        updateTicket(db, t.id, { githubIssueNumber: issue.number, githubIssueUrl: issue.html_url });
        log.info(`queued-sync: created ${t.githubRepo}#${issue.number} (ticket ${t.id}), labelled ${QUEUED_LABEL}`);
        continue;
      }
      // Linked: add sortie:queued only if the issue has no sortie:* label yet.
      const res = await fetchImpl(
        `https://api.github.com/repos/${t.githubRepo}/issues/${t.githubIssueNumber}`,
        { headers: ghHeaders(token) },
      );
      if (!res.ok) {
        log.error(`queued-sync: read ${t.githubRepo}#${t.githubIssueNumber} -> HTTP ${res.status}`);
        continue;
      }
      const issue = (await res.json()) as GithubIssue;
      const hasSortieLabel = (issue.labels ?? []).some((l) => l.name.toLowerCase().startsWith('sortie:'));
      if (hasSortieLabel) continue;
      const add = await fetchImpl(
        `https://api.github.com/repos/${t.githubRepo}/issues/${t.githubIssueNumber}/labels`,
        { method: 'POST', headers: ghHeaders(token, true), body: JSON.stringify({ labels: [QUEUED_LABEL] }) },
      );
      if (!add.ok) {
        log.error(`queued-sync: label ${t.githubRepo}#${t.githubIssueNumber} -> HTTP ${add.status}`);
        continue;
      }
      log.info(`queued-sync: labelled ${t.githubRepo}#${t.githubIssueNumber} ${QUEUED_LABEL}`);
    } catch (err) {
      log.error(
        `queued-sync: ticket ${t.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Env var holding the read-only GitHub token — PD-165 label→board read sync. */
export const GITHUB_READ_TOKEN_ENV = 'GITHUB_READ_TOKEN';
/** Env var holding the write-scoped GitHub token (Issues: read & write) — PD-164 queued-issue sync. */
export const GITHUB_WRITE_TOKEN_ENV = 'GITHUB_WRITE_TOKEN';
/** Poll cadence — every minute (Sortie itself polls ~30s; board reflection can lag a little). */
const SYNC_SCHEDULE = '* * * * *';

/**
 * CUTOVER (C6/D-055/PD-347): the board DB is now authoritative — the GitHub sync jobs are RETIRED,
 * so this registers nothing. Both directions are gone by design:
 *   - label→board read sync (`runGithubSync`) derived ticket state FROM `sortie:*` labels. That is
 *     the coupling bug the cutover fixes: it overwrote the Robot loop's `in-review` hand-off back to
 *     `queued` from a stale label, re-dispatching the same ticket (PD-347 field note).
 *   - queued→issue write sync (`runQueuedSync`) minted GitHub issues to feed Sortie's label poll.
 *     Issue-minting is retired (PD-164): the board Ticket is the durable spec and the PR is the
 *     execution lease + review surface; no issues are created.
 * The Robot loop owns every transition natively now — dispatch, rework, and terminal completion (its
 * PR-state poll marks a ticket completed when the PR merges). The dead `deriveState`/`runGithubSync`/
 * `runQueuedSync` code and the `sortie:*` label strings are swept out in C7's dead-config pass; they
 * are left in place here (still unit-tested) so this cutover PR is a pure behavioural flip.
 */
export function registerGithubSyncJob(_cron: CronRegistry, log: CronLogger, _db: Database.Database): void {
  void SYNC_SCHEDULE; // retained for the C7 sweep; no job is scheduled at cutover
  log.info(
    'github-sync: RETIRED at cutover (C6/D-055) — board DB is authoritative; GitHub labels/issues are no longer read or written for ticket state.',
  );
}
