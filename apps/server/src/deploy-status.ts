// Fetched once at server startup; cached for the lifetime of the process.
// At deploy time Watchtower recreates the container → fresh startup → fresh fetch.
const SERVER_START_MS = Date.now();

export interface DeployInfo {
  sha: string | null;
  startedAt: number;
  commitMessage: string | null;
  commitDate: string | null;
  workflowRunUrl: string | null;
}

let _cached: DeployInfo | null = null;

interface GHCommit {
  commit?: { message?: string; author?: { date?: string } };
}
interface GHRuns {
  workflow_runs?: Array<{ html_url?: string }>;
}

async function ghFetch(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'personal-dashboard/1.0' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${url}`);
  return res.json();
}

export async function initDeployStatus(): Promise<void> {
  const sha = process.env.APP_VERSION;
  if (!sha || sha === 'dev') {
    _cached = { sha: null, startedAt: SERVER_START_MS, commitMessage: null, commitDate: null, workflowRunUrl: null };
    return;
  }

  const [commitResult, runsResult] = await Promise.allSettled([
    ghFetch(`https://api.github.com/repos/scolacur/personal-dashboard/commits/${sha}`),
    ghFetch(`https://api.github.com/repos/scolacur/personal-dashboard/actions/runs?head_sha=${sha}&event=push&per_page=1`),
  ]);

  let commitMessage: string | null = null;
  let commitDate: string | null = null;
  if (commitResult.status === 'fulfilled') {
    const data = commitResult.value as GHCommit;
    const raw = data?.commit?.message ?? '';
    commitMessage = raw.split('\n')[0] || null;
    commitDate = data?.commit?.author?.date ?? null;
  }

  let workflowRunUrl: string | null = null;
  if (runsResult.status === 'fulfilled') {
    const data = runsResult.value as GHRuns;
    workflowRunUrl = data?.workflow_runs?.[0]?.html_url ?? null;
  }

  _cached = { sha, startedAt: SERVER_START_MS, commitMessage, commitDate, workflowRunUrl };
}

export function getDeployInfo(): DeployInfo {
  return _cached ?? {
    sha: process.env.APP_VERSION ?? null,
    startedAt: SERVER_START_MS,
    commitMessage: null,
    commitDate: null,
    workflowRunUrl: null,
  };
}

export function resetDeployStatusForTest(): void {
  _cached = null;
}
