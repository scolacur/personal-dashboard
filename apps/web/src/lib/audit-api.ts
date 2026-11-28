import type { AuditFinding, AuditRun, SetFindingDecisionInput } from '@dashboard/shared';

// Ticket Audit API client (D-045, PD-283/PD-286). Lives in $lib because the nav badge is
// mounted app-wide (SideNav), not inside the task-monitor route. The report pages + the
// Recurring Jobs card reuse the same client.
const BASE = '/api/widgets/task-monitor/audit';

/** All runs, newest-first (server orders by id DESC). */
export async function fetchAuditRuns(): Promise<AuditRun[]> {
  const res = await fetch(`${BASE}/runs`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<AuditRun[]>;
}

/** A single run plus its findings. 404s if the run id doesn't exist. */
export async function fetchRunFindings(
  runId: number,
): Promise<{ run: AuditRun; findings: AuditFinding[] }> {
  const res = await fetch(`${BASE}/runs/${runId}/findings`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<{ run: AuditRun; findings: AuditFinding[] }>;
}

/**
 * Enqueue a run on demand. The server coalesces onto any pending/running run and always
 * replies 202 with `created` telling which happened — so firing this while a run is in
 * flight is a safe no-op that just returns the existing run.
 */
export async function requestAuditRun(): Promise<{ run: AuditRun; created: boolean }> {
  const res = await fetch(`${BASE}/runs`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<{ run: AuditRun; created: boolean }>;
}

/**
 * Apply a human decision to a finding (PD-826). Accepting an actionable finding performs the
 * corresponding ticket mutation server-side; rejecting records the optional reason. Returns the
 * updated finding. Surfaces the server's error `code` in the thrown message so the UI can explain
 * a refusal (e.g. a reprioritize accepted without a target P-level).
 */
export async function setFindingDecision(
  findingId: number,
  input: SetFindingDecisionInput,
): Promise<AuditFinding> {
  const res = await fetch(`${BASE}/findings/${findingId}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string; code?: string };
      if (err.error) detail = err.error;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<AuditFinding>;
}
