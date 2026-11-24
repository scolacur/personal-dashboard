# D-116: The agent-worker auto-deploys from GHCR through its own scoped Watchtower, drained by a fail-closed pre-update hook (PD-816; supersedes the "worker NOT on GHCR/Watchtower" line)

**Date:** 2026-11-24 · **Epic:** PD-762 (Auto-merge Robot PRs once checks pass and the Evaluator ships) · **Ticket:** PD-816 (Wire the dedicated, scoped Watchtower to auto-recreate the worker) · **Parent:** PD-802 (Auto-deploy the agent-worker on merge) · **Supersedes:** the "agent-worker is deliberately NOT on GHCR/Watchtower" line in [[D-035]] and [[D-079]] · **Amends:** [[D-105]] (its exit-code claim) · **Related:** [[D-044]] (the agent-worker), [[D-104]] (SIGTERM drain), [[D-079]] (BUILD_SHA)

## Context

Since D-044 the agent-worker was built on the host and redeployed by hand (`robot-refresh`). D-035 and D-079 both say it was "deliberately NOT on GHCR/Watchtower." There were two reasons. The worker holds secrets: the Anthropic key, a GitHub read token, and the Robot's write token. And it runs long LLM turns, which a blind container recreate would kill. The result was that every worker merge waited on Steve to run `robot-refresh`, and the dashboard regularly showed the worker several merges behind `main`.

PD-814 (publish the worker image to GHCR) and PD-815 (deploy-drain CLI + release the hold on startup) removed both reasons. This decision wires the host side.

## Decision

1. **The worker runs the public GHCR image** `ghcr.io/scolacur/personal-dashboard-agent-worker:latest`, published by `deploy.yml`.
2. **A dedicated Watchtower in the egress compose** (`agent-worker-watchtower`) recreates the worker when `:latest` moves. It is separate from the app's Watchtower for two reasons. Lifecycle hooks, which run the drain, must stay off the app's instance. And the worker deploys independently of the app.
3. **Both Watchtowers are scoped**, because they share one Docker daemon:
   - **Worker's instance:** `WATCHTOWER_SCOPE=agent-worker`. It carries the scope label itself, and the worker carries it alongside `watchtower.enable=true`. The squid sidecar carries neither, so it is never watched.
   - **App's instance:** `WATCHTOWER_SCOPE=none`. Watchtower treats a missing, empty or `none` scope label as scope `none`, so this instance still sees the unlabelled-scope `app` and ignores the worker.
   - **Why the app's instance must be rescoped too.** An **unscoped** Watchtower watches every container regardless of scope, and it *removes every other Watchtower instance*, scoped ones included. So the app's instance must be rescoped **before** the worker's starts. The runbook in `ops/agent-worker/README.md` has that order.
4. **The drain runs as a pre-update hook inside the worker**: `node /app/apps/agent-worker/dist/deploy-drain.js`, with `WATCHTOWER_LIFECYCLE_HOOKS=true` on the worker's Watchtower only. It exits 75 while a Robot run is in flight, so Watchtower skips the update and retries on the next poll, by which time the deploy hold has stopped new dispatch. It exits 0 when nothing is in flight, and the recreate proceeds. The new container releases the hold on boot (D-105).
5. **The drain fails closed.** Every failure exits 75: config load, DB open or lock, or a throw inside the drain. This **amends D-105**. D-105 said "any other non-zero code cancels" the update, and Watchtower's docs say the opposite: exit 75 is the *only* code that stops an update. Any other non-zero code is logged and the recreate goes ahead. A crashing drain that exited 1 would let the recreate kill the run the hook exists to protect. Failing closed costs one poll interval. If the drain is broken for good, auto-deploy stays blocked and the failure is loud in the logs, and `robot-refresh` still deploys by hand.
6. **Watchtower's stop timeout is set to 30s** (`WATCHTOWER_TIMEOUT`). Watchtower ignores compose's `stop_grace_period` and defaults to 10s, which would cut off the D-104 SIGTERM drain.
7. **The worker publishes only on worker-affecting merges.** BUILD_SHA changes the image digest on every build, so an unconditional publish would drain and recreate the worker on every merge, web-only ones included. Each drain also holds new Robot dispatch until in-flight runs finish. An `agent-worker-changed` job in `deploy.yml` diffs the pushed range against the worker's build inputs: the root manifests and lock, `tsconfig.base.json`, `.dockerignore`, `packages/shared`, `apps/agent-worker`, the worker Dockerfile, and the workflow itself, and the list file. The worker job runs only when one of those changed. Manual dispatch, or a range that can't be resolved, publishes anyway. BUILD_SHA then names the last worker-affecting commit, which is the worker's real version.
   The inputs are listed once, in `ops/agent-worker/build-inputs.txt`, and a spec checks the list against the Dockerfile's COPYs. The heartbeat reads the same file and reports `build_current`, which is true when no input changed between BUILD_SHA and the grounding checkout's HEAD. `workerVersionState` treats that as current, so the Dev Ops readout doesn't say "behind main" after every web-only merge. When the worker can't tell (`null`), only exact sha equality counts as current, as D-079 requires.
8. **Manual paths:**
   - **`robot-refresh`** pulls from GHCR and runs `up -d`. It is *forced*: it skips the drain, so an in-flight run is SIGTERM-drained (D-104).
   - **`robot-rebuild`** is the old local build, kept for emergencies. It tags the image locally and sets `AGENT_WORKER_IMAGE` so compose runs that tag. Watchtower can't pull a local-only tag, so the emergency build stays up until the next `robot-refresh`.

## Why the original reasons no longer hold

- **Secrets.** The image bakes none. Every secret comes from `env_file` at runtime (`agent-worker.env`, outside the repo), so a public image exposes code that is already public. The uid split (D-039/D-055) doesn't depend on where the image is built. The Dockerfile creates the `robot` user (uid 1500) and runs the loop as root. The drop to uid 1500 is turned on by `ROBOT_CODING_UID`/`ROBOT_CODING_GID` in the env file. `dashboard.db`'s mode is a property of the host mount. A CI-built image therefore enforces the split exactly as a host-built one does. Confirm it on the first GHCR boot, as the runbook says.
- **Long LLM turns.** The drain now waits for in-flight Robot runs instead of interrupting them, and the SIGTERM drain (D-104) covers the forced paths. One gap remains: an in-flight **Refine** or **Audit** turn is not drained yet. That is PD-980 (deploy drain also waits on in-flight Refine and Audit turns), in the same epic. Until it lands, a recreate can cut such a turn short. A Refine thread resumes by session id, so the thread survives and only the current turn is lost.
- **Self-modification.** A Robot PR that touches the worker's own runtime is still gated by the path-guard (`apps/agent-worker/**` in `.github/sensitive-paths.txt`, D-047/D-109) before it can merge, and therefore before it can deploy.

## Implications

- The Mac Mini build (PD-787, agent-worker egress stack) becomes a GHCR pull, not an on-host build. The Mini needs no build toolchain for the worker.
- `containrrr/watchtower` is unmaintained. If the Mini's Docker is new enough to reject its API version, set `DOCKER_API_VERSION` on both instances or move to a maintained fork. Its scope semantics, described above, are the contract to preserve.

**Revisit if:** the GHCR package goes private (Watchtower then needs a mounted `config.json`, as `ops/deploy/README.md` describes); the worker gains a job the drain can't see (PD-980 is the first one); or Watchtower's hook contract changes the meaning of exit 75.
