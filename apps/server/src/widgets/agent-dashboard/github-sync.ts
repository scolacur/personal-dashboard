import type Database from 'better-sqlite3';
import type { AgentState, TicketStatus } from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import { applyDerivedState, listQueuedIssueTargets, listSyncTargets, updateTicket } from './store';

// PD-165: derive board status + agent state from a linked issue's `sortie:*` labels
// by polling GitHub (D-020: labels are the state machine, not the Sortie :7678 API).
// Dependency-free HTTP (built-in fetch) so it needs no new package and honours the
// container's HTTPS_PROXY (squid egress). Only READ access is required.

export interface DerivedState {
  status: TicketStatus;
  agentState: AgentState | null;
}

// Precedence-ordered: first matching label wins (Sortie applies one active state at
// a time, but ordering makes a stray extra label deterministic). Only 'working'
// drives the active shimmer; stuck/needs-human/awaiting-human are paused-need-attention.
const LABEL_RULES: readonly { label: string; status: TicketStatus; agentState: AgentState | null }[] = [
  { label: 'sortie:stuck', status: 'in_progress', agentState: 'stuck' },
  { label: 'sortie:needs-human', status: 'in_progress', agentState: 'needs-human' },
  { label: 'sortie:awaiting-human', status: 'in_progress', agentState: 'awaiting-human' },
  { label: 'sortie:in-review', status: 'in_review', agentState: null },
  { label: 'sortie:in-progress', status: 'in_progress', agentState: 'working' },
  { label: 'sortie:done', status: 'completed', agentState: null },
] as const;

/**
 * Map an issue's labels + open/closed state to a derived (status, agentState), or
 * `null` when no rule applies — meaning "leave the ticket's status alone" (e.g. only
 * `sortie:queued`, or no sortie label yet).
 */
export function deriveState(labels: string[], issueState: 'open' | 'closed'): DerivedState | null {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  // sortie:wontfix is a terminal label that maps to board `closed` regardless of
  // whether the GitHub issue is still open or already closed — checked before the
  // generic closed→completed fallback so it is never swallowed by it.
  if (set.has('sortie:wontfix')) return { status: 'closed', agentState: null };
  // Closed is terminal and authoritative: a closed issue is completed regardless of
  // any stale non-terminal label still hanging on it (e.g. an issue closed while it
  // still wore sortie:in-review). Checked before LABEL_RULES so stale labels can't
  // override a closed issue state.
  if (issueState === 'closed') return { status: 'completed', agentState: null };
  // Open issue: derive from its active sortie:* label (precedence-ordered).
  for (const rule of LABEL_RULES) {
    if (set.has(rule.label)) return { status: rule.status, agentState: rule.agentState };
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
        log.error(`github-sync: ${t.githubRepo}#${t.githubIssueNumber} -> HTTP ${res.status}`);
        continue;
      }
      const issue = (await res.json()) as GithubIssue;
      const derived = deriveState((issue.labels ?? []).map((l) => l.name), issue.state);
      if (derived && applyDerivedState(db, t.id, derived.status, derived.agentState)) {
        log.info(
          `github-sync: ${t.githubRepo}#${t.githubIssueNumber} -> ${derived.status}/${derived.agentState ?? '-'}`,
        );
      }
    } catch (err) {
      log.error(
        `github-sync: ${t.githubRepo}#${t.githubIssueNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
 * Register the GitHub sync jobs. Each direction is gated on its own token and is a
 * no-op (with a log line) when that token is unset, so dev and partially-provisioned
 * deploys boot cleanly:
 *   - GITHUB_READ_TOKEN  → label→board status sync (PD-165, read)
 *   - GITHUB_WRITE_TOKEN → queued ticket → GitHub issue+label (PD-164, write)
 */
export function registerGithubSyncJob(cron: CronRegistry, log: CronLogger, db: Database.Database): void {
  const readToken = process.env[GITHUB_READ_TOKEN_ENV];
  if (readToken) {
    cron.register('agent-dashboard:github-sync', SYNC_SCHEDULE, () =>
      runGithubSync({ db, token: readToken, log }),
    );
  } else {
    log.info(
      `github-sync: ${GITHUB_READ_TOKEN_ENV} not set — label→board sync disabled (set it to enable derived status).`,
    );
  }

  const writeToken = process.env[GITHUB_WRITE_TOKEN_ENV];
  if (writeToken) {
    cron.register('agent-dashboard:queued-sync', SYNC_SCHEDULE, () =>
      runQueuedSync({ db, token: writeToken, log }),
    );
  } else {
    log.info(
      `queued-sync: ${GITHUB_WRITE_TOKEN_ENV} not set — queued→issue sync disabled (set it to enable issue creation + labelling).`,
    );
  }
}
