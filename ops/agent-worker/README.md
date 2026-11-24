# agent-worker — deploy checklist

The **agent-worker** is the dashboard-owned interactive triage agent (DECISIONS **D-044**): a
Claude Agent SDK / Opus worker that refines a ticket with Steve, then proposes a commit
(refine-in-place or decompose) for approval. It runs as a **separate, egress-hardened
container** from the web app — it holds `ANTHROPIC_API_KEY` and does long LLM turns, so it is
deliberately **NOT** part of the web app's CI/CD. Deploy it by hand with the steps below.

Transport between the web app and the agent-worker is the **shared SQLite DB** (`dashboard.db`),
not HTTP — so the agent-worker's `/data` mount MUST be the same host directory the web app mounts
as `/data`, or it opens a different DB and never sees your tickets.

## Prerequisites

- Prod host = the **NAS** (`192.168.68.50`), Synology `/volume1/...` layout — being migrated to an
  always-on **Mac Mini M4 / Colima** (epic PD-188, mechanics in DECISIONS **D-035**). The deploy
  steps are the same on either host; the host-forced differences are called out inline below.
- The repo is checked out on the host at
  `/volume1/docker/personal-dashboard/personal-dashboard/` **(NAS)**. On the **Mini**, adjust the
  compose's host paths per D-035, and **`/data` must be a Colima VM-native volume, not a macOS-host
  bind mount** — a host mount's virtiofs layer flattens Linux mode/uid semantics and breaks the
  uid-split (`robot` uid-1500 exclusion), quietly gutting the kernel-enforced half of D-039.
- Two secrets (see [Secrets & tokens](#secrets--tokens)): a Claude credential (a metered
  `ANTHROPIC_API_KEY` **or** a Pro `CLAUDE_CODE_OAUTH_TOKEN`) and a GitHub token with
  **Contents: Read** on `scolacur/personal-dashboard`.
- `docker` on the host: on the **NAS** it needs `sudo` (interactive — the NAS sudo is
  password-gated, so a container can't be killed over non-interactive SSH). On the **Mini**, Colima
  runs `docker` **sudoless per-user** — drop the `sudo` from the commands below.

## Deploy

Run on the NAS over SSH:

```bash
# 1. Get main onto the host checkout (the dir the compose's squid.conf path points at)
cd /volume1/docker/personal-dashboard/personal-dashboard
git checkout main && git pull --ff-only

# 2. Create the agent-worker's OWN env file — NOT the web app's .env
cp ops/agent-worker/agent-worker.env.example /volume1/docker/personal-dashboard/agent-worker.env
#    edit it and fill in ANTHROPIC_API_KEY and GITHUB_READ_TOKEN

# 3. Pull the published image (public on GHCR, built by deploy.yml, no secrets baked in, D-116)
sudo docker-compose -f ops/agent-worker/docker-compose.egress.yml pull agent-worker

# 4. Bring it up on the egress-hardened network: proxy sidecar + internal net + the worker's own
#    scoped Watchtower. FIRST TIME ON A HOST that also runs the app's Watchtower: do the
#    "Auto-deploy cutover" below first, or the app's unscoped Watchtower removes this one.
sudo docker-compose -f ops/agent-worker/docker-compose.egress.yml up -d

# 5. Watch it boot and take a turn
sudo docker logs -f agent-worker
```

## Verify

Healthy boot logs, in order:

- `agent-worker starting`
- `routing egress through squid proxy`
- `cloning grounding checkout` (first run only; later runs `git pull` the existing checkout)
- `grounding checkout ready`
- `refine job ready — polling for Refine turns`
- `audit job ready — polling for runs` (the autonomous audit job, D-045/PD-283)
- `agent-worker ready`

Then click **Refine** on a prod ticket. When the agent replies you should see:

- `refine: posted turn` with `warm:false` on the first turn, then `warm:true` +
  a non-zero `cacheReadTokens` on your next reply (that's the warm-session cache hit).
- If the agent proposes a commit, a `refine_proposal` row appears and the **Proposed changes**
  panel shows on the ticket-detail page.

## Secrets & tokens

All live ONLY in `agent-worker.env` (mounted as the container's `env_file`) — never in the web
app's `.env`. The Claude credential must never reach the user-facing web process.

**Claude auth — pick ONE** (if both are set, the API key wins):

- **`ANTHROPIC_API_KEY`** — metered pay-as-you-go, billed **separately from any Claude
  subscription**. A fresh key starts at **$0**, so add credits in the Console → Billing or the
  agent-worker logs a turn error `Credit balance is too low`. Cost-isolated; no shared quota. A
  dedicated key also gives its own rate-limit budget + a revocation blast-radius limited to the
  agent-worker.
- **`CLAUDE_CODE_OAUTH_TOKEN`** — your Claude Pro/Max subscription token (the same one the
  Robot loop uses; run `claude setup-token`). No extra billing, but it **shares the Pro session
  quota with the Robot loop** — and the agent-worker defaults to **Opus**, which is heavy on
  that quota, so set `AGENT_WORKER_MODEL=claude-sonnet-4-6` to ease it. An exhausted quota surfaces
  as an errored turn (left pending + logged, not written to the thread).

**`GITHUB_READ_TOKEN`** — used only to clone/pull the grounding checkout, so it needs
**Contents: Read** on `scolacur/personal-dashboard` (+ the auto-added Metadata: Read). Note the
dashboard's _existing_ read token (PD-165) is scoped for **Issues: Read** — a fine-grained
Issues-only PAT **cannot clone**. Use a classic `repo`/`public_repo` PAT, or a fine-grained PAT
with Contents: Read.

## Redeploy after a code change

**It's automatic (PD-816, D-116).** A merge that touches the worker's build inputs publishes
`ghcr.io/scolacur/personal-dashboard-agent-worker:latest` (`deploy.yml`, `agent-worker-changed` gate).
Within one poll (5 min), the stack's own Watchtower (`agent-worker-watchtower`) sees the new digest
and runs the **deploy drain** inside the worker (pre-update hook). Then:

- **Exit 75:** a Robot run is in flight. The update is skipped, the deploy hold stops new dispatch,
  and the next poll retries. The drain also exits 75 on *any* failure (fail closed). Watchtower
  only skips on 75; any other code lets the recreate through.
- **Exit 0:** nothing is in flight. Watchtower recreates the worker, and the new container
  releases the deploy hold on boot (D-105).

Merges that only touch the web app don't publish the worker, so they don't recreate it.

Manual commands (from `scripts/pd-aliases.sh`):

| Command | What it does | When |
|---|---|---|
| `robot-refresh` | `git pull`, `compose pull`, `up -d` from GHCR | Deploy **now** without waiting for the poll, or return from `robot-rebuild`. **Forced:** skips the drain, so an in-flight run is SIGTERM-drained (aborted, WIP pushed, closed `interrupted`, D-104). |
| `robot-rebuild` | Local `docker build` (BUILD_SHA stamped) to `$PD_IMAGE`, then `up -d` with `AGENT_WORKER_IMAGE` pointing at it | **Emergency only:** CI or GHCR is down, or a fix can't wait for a merge. Watchtower can't pull the local tag, so auto-deploy pauses until the next `robot-refresh`. |

Confirm a deploy landed:

```bash
sqlite3 /volume1/docker/personal-dashboard/personal-dashboard/data/dashboard.db \
  'SELECT worker, build_sha, sha FROM worker_heartbeat;'
sudo docker logs agent-worker-watchtower | tail     # "Found new ... image", or the hook's skip
```

`build_sha` is the short sha of the last **worker-affecting** merge. It does not move on web-only
merges, so it can trail `main` and still be current. If it is **empty**, the image wasn't stamped;
see below.

### Auto-deploy cutover (one time per host) 🧑

Done on the NAS on 2026-11-24. You'll only need it again on a new host (the Mac Mini, PD-787) or
after rebuilding the stack from scratch.

Two Watchtowers share one Docker daemon, so **order matters**. An unscoped Watchtower removes every
other Watchtower instance, scoped ones included. Every path below is absolute, so it works from
any directory (an SSH session starts in your home dir, not the repo). Set `R` to the host's checkout.

```bash
R=/volume1/docker/personal-dashboard/personal-dashboard
git -C $R pull --ff-only

# 1. Rescope the APP's Watchtower to `none` FIRST, so it stops watching the worker and stops
#    removing other instances. Check the pulled compose has the scope before you apply it.
grep WATCHTOWER_SCOPE $R/docker/docker-compose.nas.yml      # must print WATCHTOWER_SCOPE=none; stop if not
sudo docker-compose -f $R/docker/docker-compose.nas.yml up -d watchtower

# 2. Switch the worker to the GHCR image and start its scoped Watchtower. This recreates the
#    worker WITHOUT the drain, so run it when no Robot run is in flight.
sudo docker-compose -f $R/ops/agent-worker/docker-compose.egress.yml pull agent-worker
sudo docker-compose -f $R/ops/agent-worker/docker-compose.egress.yml up -d

# 3. Verify.
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
sudo docker logs agent-worker-watchtower 2>&1 | head
sudo docker exec agent-worker sh -c 'id; id robot; ls -l /data/dashboard.db'
```

Step 3 should show:

- **`docker ps`:** `agent-worker` runs a `ghcr.io/scolacur/personal-dashboard-agent-worker` image, and
  BOTH Watchtowers are up. If the app's Watchtower is gone, step 1 didn't take; redo it.
- **The worker Watchtower's log:** it mentions scope `agent-worker`.
- **The uid split (D-039/D-055):** `id` shows root (the loop), `id robot` shows uid 1500 (the coding
  session), and `dashboard.db` is `-rw-rw----`.

> **Don't run `deploy-drain.js` by hand to test it.** It takes the deploy hold. If no recreate
> follows, Robot dispatch stays blocked until the hold lapses (stall threshold, about 2h). If you
> did run it, `robot-refresh` recreates the worker and releases the hold on boot.

**Prove the loop once:** merge a worker-touching PR. Within about 5 min, `build_sha` should move with
no manual step. To check the drain path, land one while a Robot run is in flight: the Watchtower log
shows the hook skip, the run finishes, and the next poll recreates the worker.

### Always pass `BUILD_SHA`

`Dockerfile` declares `ARG BUILD_SHA=""` and bakes it into `AGENT_WORKER_BUILD_SHA`, which is the
`build_sha` the heartbeat reports (D-079, PD-528). `deploy.yml` passes it on every publish, and
`robot-rebuild` passes it on the emergency path. A hand-run `docker build` without
`--build-arg BUILD_SHA=...` reports an empty sha, and the Dev Ops readout can no longer say what
the worker is running.

## Troubleshooting

- **Turns hang / API errors** — the agent-worker reaches `api.anthropic.com` only through the squid
  sidecar (`ops/agent-worker/squid.conf`, which allowlists `.anthropic.com` +
  `.github.com`). Check the proxy env vars in the compose and the squid allowlist.
- **`no such table` / agent-worker sees no tickets** — the `/data` mount isn't the web app's DB
  dir, so the agent-worker opened an empty DB (it doesn't run schema bootstrap). Both must mount the
  **repo-root** `data/`: `/volume1/docker/personal-dashboard/personal-dashboard/data` (note the
  nested repo dir — the web app's `../data` from `docker/`), NOT the base
  `/volume1/docker/personal-dashboard/data`. `find /volume1/docker/personal-dashboard -name
dashboard.db` shows the real one (large) vs a stray empty one.
- **Clone fails** — the `GITHUB_READ_TOKEN` lacks Contents: Read (see above).
- **`Permission denied` creating `/data/agent-worker-checkout` or writing the DB** — the agent-worker runs
  as **root**, matching the web app that owns the shared `dashboard.db` (+ its WAL/-shm). If you
  see this, the container isn't running as root (stale image) — rebuild, or confirm the
  Dockerfile has no `USER` drop.
