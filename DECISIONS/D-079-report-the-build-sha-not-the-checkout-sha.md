# D-079: A worker reports the commit it was BUILT from, not the one it reads (PD-528)

**Decision:** The agent-worker's version is the commit its **image was built from**, stamped in at
`docker build` time (`ARG BUILD_SHA` → `ENV AGENT_WORKER_BUILD_SHA`) and reported on the heartbeat as
`build_sha`. The pre-existing `sha` — the grounding checkout's HEAD — is renamed `checkoutSha` in the
API and is no longer shown as a version. Site Status renders the build sha, flags **behind main**
when the two differ, and reports **unknown** when the image carries no stamp.

**Reasoning:**

- **The old field was a number that looked like a version and was not one.** `currentSha()` runs
  `git rev-parse HEAD` against `AGENT_WORKER_CHECKOUT_DIR` — the read-only checkout the agent grounds
  against, which the worker re-pulls every few minutes. It tracks `main` and moves **without the
  worker restarting**. A container running week-old code therefore advertised a sha from minutes ago.
- **This was found by nearly shipping a silent failure, not in the abstract.** On 2026-08-13
  `robot-uptime` ([[D-055]]/PD-391) reported the container `Up 7 days` while Site Status showed a
  fresh sha. The image predated PD-306, PD-248, PD-310 and PD-487 — so setting `EVALUATOR_ENABLED=1`
  for the PD-468 turn-on would have done **nothing at all**: no error, no missing-flag warning, and
  a dashboard that looked healthy. An observability field that answers a *different question* than
  the one being asked is worse than a missing one, because it is trusted.
- **Both shas are kept, because they answer different questions.** `checkoutSha` is what the agent
  READS — genuinely useful when a Robot's grounding looks stale. `buildSha` is what the worker RUNS.
  Conflating them is the bug; dropping either would lose real information.
- **The pair gives "deploy is behind" for free.** The checkout tracks `main`, so `buildSha !==
  checkoutSha` *is* "the running worker is older than main" with no new plumbing and nothing extra
  to query. That is the signal a human actually wants before flipping a feature flag.
- **`unknown` is deliberately distinct from `stale`.** An image built before the build-arg existed
  reports no stamp. Falling back to the checkout sha would recreate the original bug exactly, and
  rendering it as `current` would be false reassurance from the other direction. "We cannot tell"
  gets its own state and its own muted styling, with the fix named in the tooltip
  (`robot-refresh`).
- **Renamed rather than redefined.** `sha` could have been repointed at the build commit, keeping
  the field name. But the name is what misled — a bare `sha` on a worker row reads as "this
  worker's version" to everyone. `checkoutSha` cannot be misread that way, and the rename is what
  stops the same mistake being made again by the next reader.
- **Stamped by `robot-refresh`, not by CI.** The agent-worker is deliberately NOT on the
  Watchtower/GHCR auto-update path (only the web app is), so `robot-refresh` *is* the deploy. The
  build arg belongs where the build happens. An unstamped local `docker build` still works and
  simply reports unknown.

**Implications:** `worker_heartbeat` gains a `build_sha` column (worker-owned DDL and the server's
`schema.ts` migration, which must stay in step). `WorkerHeartbeat.sha` → `checkoutSha` + `buildSha`,
so any future consumer must choose which it means. `workerVersionState()` lives in `packages/shared`
so the rule is tested once rather than re-derived in a `.svelte` file.

**Revisit if:** the agent-worker ever joins the auto-update path. The stamp would then belong in CI
alongside the image push, and "behind main" would become a much rarer state worth alerting on rather
than merely displaying.
