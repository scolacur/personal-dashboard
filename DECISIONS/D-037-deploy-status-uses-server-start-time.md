# D-037: Deploy status uses server-start time as deploy proxy; GitHub API fetched once at startup (PD-111)

**Decision:** The home page live-status bar shows: deploy time (server process start time as proxy), git SHA linked to the GitHub commit or Actions run, and the commit message. The server fetches GitHub API exactly once at startup (fire-and-forget, cached for the process lifetime) from `apps/server/src/deploy-status.ts`. The frontend reads `/api/deploy-info` once on mount — no polling.

**Why server-start = deploy time:** Watchtower recreates the container whenever it sees a new `:latest` digest. That recreation = a fresh process start. So `Date.now()` at module load is effectively "when this image was deployed."

**Why fetch GitHub API at server startup (not at browser load):** GitHub's unauthenticated API limit is 60 req/hr shared across the host IP. Fetching once at server startup means one request per deploy regardless of how many browser sessions load the dashboard. The server caches the result and serves it indefinitely.

**Why not bake more metadata into the image:** CI/Dockerfile are off-limits per the repo's agent scope rules. `APP_VERSION` (7-char SHA) is already set by `deploy.yml`; all other metadata (commit message, Actions run URL) is derived from it via the GitHub public API at runtime.

**Alternatives considered:** polling GitHub API from the browser on each page load (hits rate limit quickly on busy days), writing a `deploy.json` sidecar file at build time (requires CI change), querying the GitHub API on every `/api/deploy-info` request (redundant after the first hit).
