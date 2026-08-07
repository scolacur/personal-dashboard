# D-043: Board reflects GitHub changes via an on-demand sync trigger (page-load + "Sync now"), not just the once-a-minute cron (PD-252)

**Decision:** The Task Monitor board triggers a server→GitHub reconciliation **on page load and via a "Sync now" button**, in addition to the existing `* * * * *` cron. New endpoint `POST /api/widgets/agent-dashboard/sync` runs `runGithubSync` on demand; the frontend calls it on mount, then re-reads tickets. The trigger is guarded by `requestGithubSync` — concurrent callers **coalesce** onto one in-flight pass, and calls within 10s of the last pass are **throttled** — so refresh spam / many open tabs can't hammer GitHub's rate limit.

**Why:**

- **Issue status & labels are GitHub-owned** and only land in the DB via the cron ([[D-040]] Notification Center, PD-165 label→status sync). So closing an issue on GitHub took up to ~60s to show — and crucially, **neither a hard refresh nor the 30s client poll could beat it**, because both only re-read the not-yet-synced DB. The staleness was server-side, not a fetch/cache bug.
- **Webhooks are the "right" push fix but aren't reachable today** — PD is LAN-only and external ingress is explicitly out of MVP scope (webhooks need inbound exposure; contrast web push in [[D-040]], which is outbound-only). On-demand pull needs no ingress.
- **A guard, not raw triggering,** keeps the GitHub API budget safe: authenticated limit is ~83 req/min and each pass costs one request per linked ticket, so uncontrolled per-refresh pulls could blow the budget. Coalesce + 10s throttle bounds it while still making "I just closed it → refresh → it's there" work within seconds.

**Trade-off:** a change made <10s after a prior pass can be throttled and miss that refresh; acceptable — 10s is a large improvement over 60s and the next poll/refresh catches it.
