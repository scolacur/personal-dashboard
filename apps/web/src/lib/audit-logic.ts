import type { AuditFinding, AuditRun, AuditRunStatus } from '@dashboard/shared';

// Pure helpers for the Ticket Audit report surface (PD-286). No fetching, no DOM — shared by
// the badge store, the report page, and the Recurring Jobs card so they agree on what "open",
// "actionable", and "in flight" mean. See audit-logic.spec.ts.

// Recommendation buckets that need no human action — excluded from the "open findings" badge
// and the report's actionable count. Everything else (archive/complete/reprioritize/update/…)
// is actionable. Kept as a denylist so a new bucket type defaults to actionable, not hidden.
export const NON_ACTIONABLE_TYPES: ReadonlySet<string> = new Set(['keep']);

export function isActionable(f: AuditFinding): boolean {
  return !NON_ACTIONABLE_TYPES.has(f.type);
}

/** Undecided = the human hasn't accepted/rejected it yet (decisions land in PD-287). */
export function isOpen(f: AuditFinding): boolean {
  return f.decision === 'undecided';
}

/** Findings that count toward the nav badge and the report's "open" view: undecided AND actionable. */
export function openActionableFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.filter((f) => isOpen(f) && isActionable(f));
}

function byIdDesc(runs: AuditRun[]): AuditRun[] {
  return [...runs].sort((a, b) => b.id - a.id);
}

/**
 * The run whose findings represent the CURRENT advisory state. Each run re-audits the whole
 * backlog, so the most recent completed (`done`) run supersedes older ones; a run still in
 * flight doesn't have findings yet. Returns null until at least one run has completed.
 */
export function pickReportRun(runs: AuditRun[]): AuditRun | null {
  return byIdDesc(runs).find((r) => r.status === 'done') ?? null;
}

/** The newest run regardless of status — drives the in-progress indicator on the card. */
export function latestRun(runs: AuditRun[]): AuditRun | null {
  return byIdDesc(runs)[0] ?? null;
}

const IN_FLIGHT: ReadonlySet<AuditRunStatus> = new Set<AuditRunStatus>(['requested', 'running']);

/** True while a run is enqueued or executing — the card shows a spinner and disables Run-now. */
export function isRunInFlight(run: AuditRun | null | undefined): boolean {
  return run != null && IN_FLIGHT.has(run.status);
}

export interface FindingBucket {
  type: string;
  findings: AuditFinding[];
}

export interface FindingGroup {
  projectId: number | null;
  buckets: FindingBucket[];
}

/**
 * Group findings project → bucket for the report. Projects ordered by id ascending (null/no
 * project last); buckets ordered alphabetically by type, findings within a bucket by id. Pure
 * and name-agnostic — the caller resolves projectId → name for display.
 */
export function groupByProjectAndBucket(findings: AuditFinding[]): FindingGroup[] {
  const byProject = new Map<number | null, Map<string, AuditFinding[]>>();
  for (const f of findings) {
    let buckets = byProject.get(f.projectId);
    if (!buckets) {
      buckets = new Map();
      byProject.set(f.projectId, buckets);
    }
    const list = buckets.get(f.type);
    if (list) list.push(f);
    else buckets.set(f.type, [f]);
  }

  const projectKeys = [...byProject.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  return projectKeys.map((projectId) => {
    const buckets = byProject.get(projectId)!;
    const bucketList: FindingBucket[] = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, list]) => ({ type, findings: [...list].sort((x, y) => x.id - y.id) }));
    return { projectId, buckets: bucketList };
  });
}
