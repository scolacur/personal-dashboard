import type Database from 'better-sqlite3';
import type { AgentState, TicketStatus } from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import { applyDerivedState, listSyncTargets } from './store';

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
 * `sortie:queued`, or no sortie label yet). Deliberately does NOT handle
 * `sortie:wontfix`: that maps to the `closed` status which doesn't exist until #49
 * ships (see PD-193). Badges for the fine-grained states are PD-194.
 */
export function deriveState(labels: string[], issueState: 'open' | 'closed'): DerivedState | null {
  const set = new Set(labels.map((l) => l.toLowerCase()));
  for (const rule of LABEL_RULES) {
    if (set.has(rule.label)) return { status: rule.status, agentState: rule.agentState };
  }
  // Closed with no terminal label (merged & auto-closed) → completed.
  if (issueState === 'closed') return { status: 'completed', agentState: null };
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

/** Env var holding the read-only GitHub token (least-privilege; see DECISIONS). */
export const GITHUB_READ_TOKEN_ENV = 'GITHUB_READ_TOKEN';
/** Poll cadence — every minute (Sortie itself polls ~30s; board reflection can lag a little). */
const SYNC_SCHEDULE = '* * * * *';

/**
 * Register the GitHub-label sync job. No-op (with a log line) when the token is
 * unset, so dev and token-less deploys boot cleanly instead of erroring.
 */
export function registerGithubSyncJob(cron: CronRegistry, log: CronLogger, db: Database.Database): void {
  const token = process.env[GITHUB_READ_TOKEN_ENV];
  if (!token) {
    log.info(
      `github-sync: ${GITHUB_READ_TOKEN_ENV} not set — GitHub label sync disabled (set it to enable derived status).`,
    );
    return;
  }
  cron.register('agent-dashboard:github-sync', SYNC_SCHEDULE, () => runGithubSync({ db, token, log }));
}
