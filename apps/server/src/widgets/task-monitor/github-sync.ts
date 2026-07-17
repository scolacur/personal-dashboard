// GitHub write helpers for the Task Monitor. The label→board read sync and the queued→issue
// write sync (PD-164/PD-165) were RETIRED at the C6 cutover (D-055/PD-347) — the board DB is
// authoritative and the Robot loop owns every ticket-state transition natively. C7 swept out the
// dead sync code (deriveState / runGithubSync / runQueuedSync / on-demand guard / the cron stub).
// What remains are the two best-effort GitHub write helpers the routes still call directly:
// close-on-delete (PD-207 A) and the ask_human reply mirror (PD-250).

interface GithubIssue {
  state: 'open' | 'closed';
  labels: { name: string }[];
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
 * `HUMAN_REPLY_MARKER` so a mirrored reply is recognisable by our own trust check.
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

// The legacy `sortie:*` label STRINGS below are intentional: they match REAL labels that the
// retired Sortie runtime historically applied to still-open GitHub issues. Close-on-delete strips
// them so an archived ticket's issue leaves any stale dispatch-candidate set. They are deliberately
// NOT renamed — the runtime is gone, but the labels can still exist on old issues out on GitHub.
const ACTIVE_SORTIE_LABELS = new Set(['sortie:queued', 'sortie:in-progress']);

/**
 * PD-207 A: cancel a linked issue when its ticket is archived — strip the legacy active
 * `sortie:*` labels (belt-and-suspenders for any pre-cutover issue) AND close it as
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

/** Env var holding the write-scoped GitHub token (Issues: read & write) — PD-207/PD-250 writes. */
export const GITHUB_WRITE_TOKEN_ENV = 'GITHUB_WRITE_TOKEN';
