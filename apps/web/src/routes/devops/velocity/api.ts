import type { RunReport, VelocityReport } from '@dashboard/shared';

const BASE = '/api/widgets/task-monitor/velocity';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Weekly completions, burndown and cycle time (PD-859). */
export function fetchVelocity(projectId?: number): Promise<VelocityReport> {
  return getJson(projectId ? `${BASE}?projectId=${projectId}` : BASE);
}

/** Weekly Robot-loop health (PD-860). Empty report when the worker has never run. */
export function fetchRunReport(projectId?: number): Promise<RunReport> {
  return getJson(projectId ? `${BASE}/runs?projectId=${projectId}` : `${BASE}/runs`);
}
