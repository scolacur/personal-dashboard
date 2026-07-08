import { writable } from 'svelte/store';
import { fetchAuditRuns, fetchRunFindings } from './audit-api';
import { openActionableFindings, pickReportRun } from './audit-logic';

// Single source of truth for the Ticket Audit nav badge (PD-286): the number of open
// (undecided + actionable) findings in the current advisory run. Shared so the SideNav badge
// and the report page stay in lockstep. Mirrors notifications-store.
export const openFindingCount = writable(0);

/**
 * Re-fetch the current advisory run's open-finding count and publish it. Best-effort: two
 * hops (list runs → that run's findings), so a transient failure just keeps the last count.
 */
export async function refreshOpenFindingCount(): Promise<void> {
  try {
    const reportRun = pickReportRun(await fetchAuditRuns());
    if (!reportRun) {
      openFindingCount.set(0);
      return;
    }
    const { findings } = await fetchRunFindings(reportRun.id);
    openFindingCount.set(openActionableFindings(findings).length);
  } catch {
    // transient — keep the last known count
  }
}
