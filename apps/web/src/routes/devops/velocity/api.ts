import type {
  BugReport,
  EpicBurndown,
  IntroductionReport,
  RunReport,
  VelocityReport,
} from '@dashboard/shared';

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

/** Per-Epic burndown over current membership (PD-897). */
export function fetchEpicBurndowns(projectId?: number): Promise<EpicBurndown[]> {
  return getJson(projectId ? `${BASE}/epics?projectId=${projectId}` : `${BASE}/epics`);
}

/** Bugs (kind = bug) filed vs fixed per week, by severity (PD-881). */
export function fetchBugReport(projectId?: number): Promise<BugReport> {
  return getJson(projectId ? `${BASE}/bugs?projectId=${projectId}` : `${BASE}/bugs`);
}

/** When fixed bugs were introduced — the worker's SZZ blame (PD-916). */
export function fetchIntroductions(projectId?: number): Promise<IntroductionReport> {
  return getJson(
    projectId ? `${BASE}/introductions?projectId=${projectId}` : `${BASE}/introductions`,
  );
}
