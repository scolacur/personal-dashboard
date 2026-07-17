# Robot loop — C1 bring-up & prove-on-one (PD-342, D-055)

The **Robot loop** is the in-house replacement for the third-party Sortie dispatcher: a `robot`
job in `apps/agent-worker` that polls `robot_queue` tickets, opens a git worktree per ticket, runs
a write-enabled coding session (a **Robot**) under a low-privilege uid, and hands off a PR. The
board DB is the queue; the loop is the sole DB writer.

**C1 is the tracer bullet.** It ships **OFF by default** so current Sortie stays primary. This doc
is the supervised checklist to prove it end-to-end on ONE ticket. It cannot be run from a dev
laptop — it needs the container (for the uid drop) and a real GitHub push.

> Scope note: C1 is skeleton only. Fault-tier retry (C2), observability UI (C3), remediation (C4),
> folding the `sortie-*.yml` bridges (C5), and the cutover + `github-sync` inversion + GH-label
> relabel (C6) are **out of scope**. C1 uses a hard-coded retry cap (`SIMPLE_RETRY_CAP = 3`) and
> leaves GitHub labels alone — so prove-on-one must avoid Sortie contention operationally (below).

---

## What the loop does per cycle

1. Selects `robot_queue` tickets in a sortie-enabled repo project that are **Sortie-ready**,
   **not blocked** (D-051), **fresh** (`agent_state` NULL/`queued`), and **on the allowlist**.
2. Sets `agent_state = working`, opens/pristine-cleans a `robot/<issue#>` worktree off `origin/main`.
3. Runs the coding session (uid-dropped `claude`); the Robot does verify → `.robot/verify-ok` →
   commit → push → `gh pr create` → `.robot/scm.json`.
4. The loop reads those filesystem signals: on a green verify **and** an open PR it records a
   `handed-off` run and sets `agent_state = in-review`; otherwise it records `no-verify`/`error`
   and re-queues (until the cap, then parks as `stuck`).

## The uid privilege-split (kernel-enforced, not prompt-enforced)

- The coding subprocess is spawned with `{ uid: ROBOT_CODING_UID, gid: ROBOT_CODING_GID }` via the
  SDK's `spawnClaudeCodeProcess` hook. The kernel drops privilege before `claude` execs.
- `dashboard.db` must be **mode 600, owned by the loop's uid**, with `ROBOT_CODING_UID` a
  *different* uid. Then the coding process gets `EACCES` on any DB access — it physically cannot
  read or write the board. This enforces D-039 structurally.
- The loop **fails closed**: `checkDbLockedFromCoder` verifies those permissions before dispatch
  (and at boot). If they aren't right, the loop refuses to start / dispatch and logs why.

---

## Container prerequisites (one-time, before the flag goes on)

The loop process runs privileged (as today); the coding session runs as a dedicated low-priv uid.

1. **Coding uid + `gh` — now baked into the image.** `ops/agent-worker/Dockerfile` creates the
   `robot` user (uid/gid **1500**, home `/home/robot`) and installs the GitHub CLI. Just rebuild
   the image; confirm with `docker run --rm agent-worker-dashboard sh -c 'id robot && gh --version'`.
2. **Lock the DB — `chmod` only, do NOT `chown`.** The mounted `dashboard.db` (+ its `-wal`/`-shm`
   sidecars) is owned by the web app's uid (on the NAS, `Steve:users`) and defaults to a permissive
   mode. Drop world access so the `robot` uid — which is neither the owner nor in the owning group —
   is locked out, while the web app (owner) and the root loop keep access. Keep the ownership as-is;
   `chown`ing away from the web app would break the board. The loop asserts this at boot and refuses
   to dispatch otherwise.
   ```sh
   cd /volume1/docker/personal-dashboard/personal-dashboard/data
   sudo chmod 660 dashboard.db dashboard.db-wal dashboard.db-shm 2>/dev/null
   sudo ls -l dashboard.db*     # want: -rw-rw---- <web-uid> <web-gid>
   ```
   Then load the board in a browser to confirm the web app still reads/writes. (If it breaks, the
   web app runs as a different uid than the file owner — `chmod 664` to revert and re-check.)

   *No worktree/checkout chown needed.* Each run gets its own **clone** that the loop creates and
   `chown`s to the `robot` uid for you (it also creates `/data/robot-worktrees` itself). The only
   host-side lockdown is the DB above.

## Environment (agent-worker's own env file — never the web process)

```sh
ROBOT_DISPATCH_ENABLED=1            # arm the loop (default off)
ROBOT_ALLOWLIST=<ticketId>          # prove-on-one: exactly ONE board ticket id (e.g. 429). Empty ⇒ nothing runs.
ROBOT_CONCURRENCY=1                 # one Robot at a time (pilot)
ROBOT_GITHUB_TOKEN=<bot PAT>        # WRITE-scoped (public_repo) — push + PR. Distinct from GITHUB_READ_TOKEN.
ROBOT_CODING_UID=1500               # the low-priv coding uid (enables the kernel privilege drop)
ROBOT_CODING_GID=1500
# optional: ROBOT_CODING_HOME (default /home/robot — matches the image), ROBOT_INTERVAL_MS,
#           ROBOT_WORKTREES_DIR, ROBOT_MAX_TURNS, ROBOT_BOT_NAME, ROBOT_BOT_EMAIL
# C2 fault guardrail: ROBOT_RETRY_CAP (3), ROBOT_PROMOTE_AFTER (2), ROBOT_BACKOFF_BASE_MS (60000),
#           ROBOT_BACKOFF_MAX_MS (900000)
# C5 folded-in bridges: ROBOT_STALL_THRESHOLD_MS (default 7200000 = 2h — a working run running longer
#           is treated as a restart orphan), ROBOT_PR_POLL_INTERVAL_MS (default 180000 = 3m — how
#           often each in-review PR is polled for review feedback / merge conflicts). The PR poll uses
#           GITHUB_READ_TOKEN (read-only); no write token needed to observe PR state.
```

## Avoiding Sortie contention (C1 is supervised)

C1 does **not** touch GitHub labels, so if the chosen ticket also carries a `sortie:*` label its
issue is still visible to the live Sortie poller — both would try to work it. For the prove-on-one
run, do ONE of:

- **Preferred:** stop the Sortie container for the duration (`sudo docker stop sortie`), or
- pick a ticket whose issue has **no `sortie:*` label** (Sortie's `query_filter` won't match it),
  and dispatch it via the board `robot_queue` only.

The Robot uses a **distinct branch namespace** (`robot/<n>`, vs Sortie's `sortie/<n>`), so even a
double-dispatch produces separate branches/PRs rather than clobbering — but avoid it anyway.

---

## Prove-on-one checklist

1. Pick a small, genuinely-Sortie-ready ticket already linked to a GitHub issue. Put it in
   `robot_queue` with `agent_state` NULL/`queued`. Set `ROBOT_ALLOWLIST` to its **board id**.
2. Apply the container prereqs + env above. Redeploy agent-worker.
3. Confirm the boot log: `robot loop ready — polling robot_queue (prove-on-one)` with
   `uidSplit: true`. If instead you see `NOT started … fail closed`, fix the DB permissions.
4. Watch: `agent_state` → `working`, a `robot/<issue#>` worktree appears, a coding session runs,
   a PR opens, `agent_state` → `in-review`, and an `agent_runs` row is `handed-off`.
5. **Verify the split is real:** from inside the container, as the coding uid, confirm the DB is
   unreadable:
   ```sh
   sudo -u robot cat /data/dashboard.db   # expect: Permission denied
   ```
6. Turn the flag back off (`ROBOT_DISPATCH_ENABLED` unset) after the run. C2 layers the fault-tier
   guardrail on top before any unattended operation.

## Rollback

Unset `ROBOT_DISPATCH_ENABLED` (or clear `ROBOT_ALLOWLIST`) and redeploy — the loop goes inert and
Sortie remains primary. No board or GitHub state needs undoing; a leftover worktree is
pristine-cleaned on next reuse or removed with `git worktree remove --force`.
