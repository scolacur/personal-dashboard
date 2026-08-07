# D-031: Mac Mini M4 becomes the primary always-on host; NAS demotes to storage/backup appliance

**Decision:** An always-on **Mac Mini M4 (24GB)** becomes the primary host for **both the dashboard
and Sortie, migrated together in one move**. The Synology NAS demotes to a **storage/backup
appliance** — it retains the DJ library and Hyper Backup → Backblaze, but stops running the app.
**The migration happens before the branch-preview feature**; previews are deferred QOL. Migration
strategy is **lift-and-shift** (keep the GHCR-image + Watchtower-pull pipeline, change only what the
new host physically forces); re-architecting the deploy model and going private are separate later
steps.

**Why move them together (not dashboard-first):** the dashboard was never the bottleneck — it ran
fine on the NAS; **Sortie** is the workload that suffered from the weak NAS (clone storms,
CPU-bound runs). More importantly, splitting them turns the **dashboard↔Sortie link** (Mission
Control → `sortie:7678`, the P3 convert-to-issue flow, the future preview reconciler reading Sortie
state) into a **cross-machine** problem — the unresolved "reach across machines" question — which
would then have to be re-wired when Sortie eventually moved. Co-locating keeps that link on one host
/ one Docker network (localhost), so it's never wired cross-machine. Cost: a bigger, riskier cutover
(Sortie's egress-hardened squid containment, tokens, `.sortie.db`, quota-refund cron all come across
and get re-verified on Colima).

**Why:** The NAS is CPU/RAM-weak — the entire deploy pipeline is pull-based (Watchtower) precisely to
avoid building on it (see the 2026-06-30 CI/CD work). The M4 is vastly more capable: it makes ~10
concurrent branch previews feasible, is a far better Sortie host, and leaves headroom. Branch
previews were the trigger for this conversation, but the powerful host is the bigger win.

**Consequences (ripples to handle during migration — mechanics now designed in [[D-034]]):**
- Dashboard + prod `dashboard.db` move to the Mini; **DJ library becomes a network mount (SMB/NFS)**
  from the NAS for music-tracker matching.
- Backups must follow the DB to the Mini. (Tracked as PD-190 — off-box target replacing Hyper Backup;
  the consistent-snapshot job itself is [[D-029]], which is host-agnostic and ports as-is.)
- **Docker on headless macOS via Colima/OrbStack, not Docker Desktop** (which needs a GUI session).
- If the repo goes private, **GHCR pull auth breaks** — the pull path needs a `read:packages` token
  (currently public/no-auth).

**Branch previews, when built (deferred, rejected alternatives recorded so they aren't
re-proposed):** an **in-process poll-based reconciler** in the Mini dashboard (reads open PRs +
running `preview-pr-*` containers each tick, converges: start/stop/evict-oldest). Rejected:
self-hosted Actions runner (public-repo fork-code risk + event-drift), cloud preview (loses the DJ
library mount, breaks the egress-hardened posture), and dashboard-GUI-driven Docker (Fastify→Docker
socket = a security surface deliberately avoided). Previews build **locally on the Mini** (native
arm64, no GHCR push) with a **deterministic per-PR URL** so a GitHub Action links it to the ticket
without polling.
