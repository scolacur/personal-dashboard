import type { MaintenanceHold, MaintenanceJob } from '@dashboard/shared';

// Client for the maintenance-hold routes (PD-498). Core routes, not widget routes — the hold is
// shared infrastructure over the Robot loop, so this sits under /api/maintenance.

const BASE = '/api/maintenance';

export interface MaintenanceStatus {
  active: MaintenanceHold | null;
  queued: MaintenanceHold | null;
  jobs: MaintenanceJob[];
}

export async function fetchMaintenanceStatus(): Promise<MaintenanceStatus> {
  const res = await fetch(`${BASE}/status`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<MaintenanceStatus>;
}

export async function fetchHolds(limit?: number): Promise<MaintenanceHold[]> {
  const query = limit != null ? `?limit=${limit}` : '';
  const res = await fetch(`${BASE}/holds${query}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<MaintenanceHold[]>;
}

export interface StartHoldResult {
  hold: MaintenanceHold;
  /** True when dispatch is already held — either it just opened, or one was already open. */
  immediate: boolean;
  /** True when an existing open window was joined rather than a new hold created. */
  joined: boolean;
}

/** Start a hold now if runs have drained, otherwise queue one for when they do. */
export async function startMaintenanceHold(): Promise<StartHoldResult> {
  const res = await fetch(`${BASE}/holds`, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<StartHoldResult>;
}

/** Run a maintenance job inside the open hold. 409s when no hold is active. */
export async function runMaintenanceJob(jobName: string): Promise<void> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobName)}/run`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
}
