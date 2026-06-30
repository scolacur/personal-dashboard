# Sortie setup — Personal Dashboard autonomous loop

Deploy + configuration runbook. Files in this dir:

- `Dockerfile` — Sortie + Claude Code + `git`/`gh` (hooks need the latter two).
- `WORKFLOW.md` — Sortie config (tracker, hooks, self-review, reactions) + the agent prompt template.
- `README.md` — this runbook.
- `quota-refund.sh` — NAS host-cron janitor that refunds `max_sessions` budget lost to
  Anthropic usage/session-quota exhaustion (see "Quota-fail budget refund" below).
- `../../.github/workflows/sortie-conflict-rework.yml` — CI bridge that re-activates a
  Sortie issue when its PR conflicts with `main` (see Architecture step 5 + Follow-ups).

**Status legend:** 🧑 = Steve (needs your hands/accounts/NAS) · 🤖 = Tank can run it.

---

## Architecture (what actually happens)

1. Sortie polls **GitHub Issues** on `scolacur/personal-dashboard` every 30s.
2. An open issue labeled `sortie:queued` is picked up; Sortie creates an isolated
   workspace and runs the hooks: **clone → branch off main → Claude Code works →
   self-review (`npm run verify`) → commit → push → open PR.**
3. The PR is authored by the **bot account** (non-admin). Branch protection requires
   **1 approval**, so the bot **cannot self-merge**. You review, approve, merge.
4. You (admin) can still **push directly to main** because protection is set with
   `enforce_admins: false`.
5. **Follow-up loops** keep an in-review PR moving (see "Follow-ups" below):
   - **Changes requested** → Sortie's native `reactions.review_comments` dispatches a
     continuation turn on the *existing* branch/PR (no relabel — the issue stays in
     `sortie:in-review`).
   - **Merge conflict** → the `sortie-conflict-rework.yml` Actions workflow flips the
     issue back to `sortie:queued`; Sortie re-dispatches a normal run that reuses the
     existing branch and merges `origin/main` to resolve the conflict.

> The GitHub *adapter* only reads issues + manages labels (it **replaces** the state
> label on a transition — removes the old state label, adds the new one — so Sortie
> itself never leaves an issue with two state labels). Branch/PR creation is done by the
> *workspace hooks* in `WORKFLOW.md` — that's where the bot token is used. The `after_run`
> hook also writes `.sortie/scm.json` (`pr_number`/`owner`/`repo`/`branch`/`sha`), which
> the reactions feature requires to locate the PR.

---

## Step 1 — Bot identity 🧑 ✅ DONE (`sortie-bot-55`, Write collaborator, classic `public_repo` PAT, email baked into WORKFLOW.md)

1. Create a new GitHub account for the bot (e.g. `sortie-bot` or `scolacur-sortie`).
   Needs its own email. GitHub ToS allows one free machine account per person.
2. Add the bot as a collaborator on `scolacur/personal-dashboard` with the **Write**
   role (NOT Admin, NOT Maintain).
3. On the **bot** account, mint a **classic PAT** (Settings → Developer settings →
   Personal access tokens → **Tokens (classic)**):
   - Scope: **`public_repo`** only (the Dashboard is public; this grants write to
     contents/PRs/issues on public repos). Nothing else — no `repo`, `admin:*`, `workflow`.
   - This token = `SORTIE_GITHUB_TOKEN`.
   - **Why classic, not fine-grained:** fine-grained PATs can only scope to repos the
     *token account owns* (or an org's). The bot is a collaborator on Steve's personal
     repo, not the owner, so the fine-grained per-repo picker is unavailable. The security
     ceiling is the bot's **non-admin Write** collaborator role + branch protection (can't
     merge/admin) — not the token scope — so a classic `public_repo` token is safe here.
4. Put the bot's GitHub **noreply email** into `WORKFLOW.md` `after_run`
   (`git config user.email …`) — find it at the bot's GitHub → Settings → Emails
   (`<id>+<user>@users.noreply.github.com`).

## Step 2 — Branch-protection cutover 🤖 ✅ DONE (verified `{"admins":false,"approvals":1}`)

Switch from the current `enforce_admins:true` / `approvals:0` workaround to the real
review gate. Pass a **typed JSON body** via `--input -` (so `required_approving_review_count`
serializes as integer `1`, not string `"1"` — the latter 422s and would leave the gate
unapplied). Exact command (Tank will run it on your go):

```sh
gh api -X PUT repos/scolacur/personal-dashboard/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null
}
JSON
```

Result: bot must open a PR + get 1 approval (can't approve its own) → you approve+merge;
you (admin) keep direct push to main.

**Mandatory verify** — the cutover is not done until this asserts the gate applied:

```sh
gh api repos/scolacur/personal-dashboard/branches/main/protection \
  --jq '{admins: .enforce_admins.enabled, approvals: .required_pull_request_reviews.required_approving_review_count}'
# expect: {"admins":false,"approvals":1}
```

> Do this **after** the bot is added (Step 1) so the gate is meaningful. Until then the
> current protection stays.

## Step 3 — Pre-create the issue labels 🤖 ✅ DONE (`sortie:queued` / `:in-progress` / `:done` / `:wontfix`)

> ⚠ **NEW label required by the follow-up loop:** `sortie:needs-human` (the
> `reactions.review_comments.escalation_label`). The adapter does **not** auto-create
> labels, so create it before deploying the reactions config:
> ```sh
> gh label create "sortie:needs-human" --repo scolacur/personal-dashboard \
>   --color B60205 --description "Sortie escalated; a human must take over" || true
> ```

## Step 4 — Build + deploy on the NAS 🧑

**NAS layout** — base dir holds secrets + runtime state OUTSIDE the repo clone, so
`git pull` / rebuilds never touch them and they never land in git:

```
/volume1/docker/personal-dashboard/
  sortie.env            secrets (chmod 600) — NOT in git
  data/                 uid 1001 — SQLite db (.sortie.db) + agent state
  workspaces/           uid 1001 — Sortie's per-issue clones
  personal-dashboard/   the repo clone (source of truth)
```

1. **Git on DSM** — not installed by default. DSM → Package Center → install **Git
   Server** (provides `/usr/bin/git`), then open a fresh SSH session. *(No-install
   alternative: `curl -L https://github.com/scolacur/personal-dashboard/archive/refs/heads/main.tar.gz | tar xz`
   into the base dir — extracts to `personal-dashboard-main/`; adjust paths below.)*
2. **Clone + prep dirs** (the container runs as **uid 1001** — `node:24-slim` already
   uses 1000 — so its writable dirs must be owned by 1001):
   ```sh
   cd /volume1/docker/personal-dashboard
   git clone https://github.com/scolacur/personal-dashboard.git
   mkdir -p data workspaces
   sudo chown -R 1001:1001 data workspaces
   ```
3. **`sortie.env`** in the base dir (`chmod 600`), containing:
   ```sh
   CLAUDE_CODE_OAUTH_TOKEN=...   # Pro plan via `claude setup-token` (or ANTHROPIC_API_KEY for metered API)
   SORTIE_GITHUB_TOKEN=...       # bot classic PAT, public_repo scope
   SORTIE_GITHUB_PROJECT=scolacur/personal-dashboard
   ```
4. **Build:**
   ```sh
   cd /volume1/docker/personal-dashboard/personal-dashboard
   sudo docker build -f ops/sortie/Dockerfile -t sortie-dashboard .
   ```
5. **Run:**
   ```sh
   sudo docker run -d --name sortie --restart unless-stopped \
     --env-file /volume1/docker/personal-dashboard/sortie.env \
     -v /volume1/docker/personal-dashboard/data:/home/sortie \
     -v /volume1/docker/personal-dashboard/workspaces:/home/sortie/workspaces \
     -v /volume1/docker/personal-dashboard/personal-dashboard/ops/sortie/WORKFLOW.md:/home/sortie/WORKFLOW.md:ro \
     -p 7678:7678 \
     sortie-dashboard
   ```
   DSM note: omit any `--init` flag (may be unavailable in Container Manager); not
   required. No privileged mode / caps needed.
6. **Health check:** `curl http://localhost:7678/readyz` → ready; `sudo docker logs -f sortie`.
7. **Update later:** `git -C /volume1/docker/personal-dashboard/personal-dashboard pull`
   → rebuild (step 4) → **recreate** the container.

   > ⚠ **Recreate, don't restart, for config/env changes.** `WORKFLOW.md` is bind-mounted
   > read-only and `sortie.env` is passed via `--env-file` *at `docker run` time*. A
   > `docker restart` reuses the old container's mounts/env snapshot and will **not** pick
   > up edits to `WORKFLOW.md` (e.g. the new `reactions` block / hooks) or `sortie.env`.
   > Recreate:
   > ```sh
   > sudo docker rm -f sortie
   > # then re-run the `docker run …` from step 5 (or, GUI: Container Manager →
   > # Project → Stop → Build → Run, which recreates the container)
   > ```
   > The SQLite DB + workspaces live on host volumes, so per-issue state survives the
   > recreate.

## Step 5 — First pilot ticket 🧑/🤖

The pilot issue already exists: **#2 "Home: empty-state when no widgets registered"**
(pure `+page.svelte` UI, D-017 acceptance shape, touches none of the forbidden areas).

- 🤖 Tank adds the `sortie:queued` label to #2 on your go.
- 🧑 Watch Sortie pick it up (logs / `GET :7678/api/v1/state`), let it open the PR,
  review + approve + merge.

---

## Open decisions (yours)

- ~~Bot account name + email~~ → `sortie-bot-55` (done).
- ~~Volume layout / env-file location~~ → base dir `/volume1/docker/personal-dashboard/` (done, Step 4).
- Which Synology user runs the container (currently via `sudo`/admin — fine for the pilot).
- Per-ticket cost/duration budget (soft-block) — tune after the first real run.
- Concurrency stays at **1** for the pilot (set in `WORKFLOW.md`).

## GUI alternative — Container Manager Project (docker-compose)

Prefer the DSM GUI to the CLI? Use `ops/sortie/docker-compose.yml` instead of the
`docker build`/`docker run` in Step 4 — same build + env + volumes + port, GUI-managed.
Container Manager → **Project** → Create → point at the compose file → it builds + runs;
start/stop/logs/rebuild are all in the UI. Steps 1–3 + the `sortie.env`/dir prep
(Step 4.1–4.3) are still prerequisites.

## Flagged / confirm against your Sortie version

- The `after_run` **PR-creation hook** is the standard `gh pr create` pattern — the
  public docs show clone/branch/commit hooks but not a PR hook. Confirm against
  `guides/setup-workspace-hooks` for your version.
- Startup token/project env var names: the Docker guide uses `SORTIE_GITHUB_TOKEN` /
  `SORTIE_GITHUB_PROJECT`; the environment reference also lists generic
  `SORTIE_TRACKER_API_KEY` / `SORTIE_TRACKER_PROJECT`. `WORKFLOW.md` references the
  former via `$`-expansion — confirm your version resolves them.
- `reactions.review_comments` sub-field names (`poll_interval_ms`, `debounce_ms`,
  `max_continuation_turns`) are from the current public `reference/reactions`. Confirm
  they validate on your installed build; older builds may name them differently. The
  block being a **map** of reaction kinds (not `enabled: bool`) is confirmed by docs.
- `.sortie/scm.json` field set — docs confirm `pr_number`/`owner`/`repo` (review_comments)
  and `branch`/`sha` (ci_failure); we write all five. Confirm the JSON keys match your
  build at first follow-up.

## Follow-ups — the in-review PR re-work loop

Once a PR is open the issue sits in `sortie:in-review` (out of the active set, so it is
not re-dispatched as a *new* attempt). Two mechanisms pick it back up:

### 1. Changes requested → re-work (NATIVE — `reactions.review_comments`)

Source: `reference/reactions`, `guides/configure-review-feedback`.

- **Trigger:** a human "Request changes" review (`reviewDecision: CHANGES_REQUESTED`) on
  the issue's PR. Bot/automated comments are filtered out by the adapter.
- **What runs:** a **continuation turn in the same existing workspace + branch** — it
  pushes fixes onto the existing PR. The prompt body (`{{ if .run.is_continuation }}`)
  tells the agent it's a follow-up, lists the `{{ .review_comments }}`, and says not to
  recreate the branch/PR.
- **No relabel.** Reactions fire *while the issue stays in `handoff_state`
  (`sortie:in-review`)*; if the issue moves to any other state the reaction's claim is
  released. So — unlike the conflict path — we deliberately do **NOT** flip the label to
  `sortie:in-progress`. (Steve's original intent was a label flip; the native mechanism
  is strictly better and a flip would actually *stop* reactions by moving the issue out of
  `handoff_state`. The single-label invariant is preserved because no relabel happens.)
- **Bounded:** comment-ID fingerprint skips unchanged reviews (no re-storm on the same
  feedback), `debounce_ms` batches edits, `max_continuation_turns: 3` is the hard ceiling,
  and per-issue `max_sessions`/`max_tokens` bind across everything. On exhaustion the
  issue is labeled `sortie:needs-human`.
- **Requires** `.sortie/scm.json` (written by `after_run`) to locate the PR.

### 2. Merge conflict → re-work (IN-REPO BRIDGE — NOT native)

Sortie has **no** reaction for a conflicting PR (`mergeable: CONFLICTING` /
`mergeStateStatus: DIRTY`); `auto_merge` only acts on clean/unstable PRs. So conflict
re-work is handled by `.github/workflows/sortie-conflict-rework.yml`:

- On every push to `main` (and via `workflow_dispatch`), it lists open `sortie/*` PRs,
  finds any now `CONFLICTING`, and for those whose issue is in `sortie:in-review` it
  **flips the label** `in-review → queued` (also stripping any stale `in-progress`, which
  keeps the single-label invariant). Sortie then re-dispatches a normal run; `before_run`
  **reuses the existing branch**, and the prompt body's retry branch merges `origin/main`
  and resolves the conflict.
- **Authorization preserved:** the label is the trigger token. The workflow uses the
  repo-scoped `GITHUB_TOKEN` (write-equivalent) and only ever labels Sortie's *own*
  (`sortie/*` head) PRs. A stranger can't push to `main`, can't create a `sortie/*` head
  branch, and the workflow reads no attacker-controlled content — so "only a write+ actor's
  label activates an issue" still holds.
- **Bounded:** it only flips from `sortie:in-review`; once flipped to `queued` the issue
  leaves that state, so re-runs are no-ops until Sortie hands back to `in-review`. Plus the
  per-issue `max_sessions`/`max_tokens` ceiling.

### Branch-reuse correctness (both paths)

`before_run` previously did `git checkout -B sortie/<id> origin/main` — which on any
follow-up would **discard the PR's commits**. It now reuses `origin/sortie/<id>` if it
exists (fetch + checkout) and only creates from `main` on the first attempt.

### Deploy-time checklist for this loop

- [ ] Create the `sortie:needs-human` label (see Step 3 note).
- [ ] **Recreate** (not restart) the NAS container so the new `WORKFLOW.md` is mounted
  (see Step 4.7).
- [ ] Confirm `reactions` validates on the installed Sortie build (see Flagged section).
- [ ] After the first PR, confirm `.sortie/scm.json` is written in the workspace and that
  a "Request changes" review actually dispatches a continuation (check logs / dashboard).
- [ ] The `.github/workflows/` file only takes effect once merged to the repo's default
  branch (GitHub runs workflows from the branch's own copy on `push`).
- [ ] Cleaning up issue #6's dual label + re-triggering PR #7 is a separate **live** step
  (Tank). This config change does not touch live GitHub state.

---

## Observability & comms: stuck-issue watchdog (Layer 1) + ask_human (Layer 2)

Sortie can't talk to Steve, so failures **silently park** an issue in an active state with
no signal — observed three ways: workspace-prep failure (the exit-128 clone loop),
`max_sessions` exhaustion, and a **container-restart orphan** (the in-memory worker dies on
restart but the issue stays `sortie:in-progress`, which is not the same as being dispatched,
so nothing re-picks it). A fourth is Sortie simply being down (issues sit in
`sortie:queued`). None of these reach `after_run` or `reactions`, so the fix is external.

### Stuck-issue watchdog (Layer 1 — `.github/workflows/sortie-watchdog.yml`)

- **Schedule:** every 30 min (`cron`), plus `workflow_dispatch` (inputs: `threshold_minutes`,
  `dry_run`) for manual/test runs.
- **What it does:** any issue in `sortie:in-progress` *or* `sortie:queued` longer than the
  threshold (default **120 min**, measured from the last `labeled <state>` timeline event)
  is flipped to **`sortie:stuck`** with an `@scolacur` comment. A healthy run finishes in
  minutes and moves the label well before that, so a breach = genuinely stalled.
- **`sortie:stuck` is NOT in `query_filter`** → the issue drops out of Sortie's candidate
  set until a human re-queues (`sortie:queued`) or drops it (`sortie:wontfix`).
- **Deliberately untouched:** `sortie:awaiting-human` (an *intentional* ask_human park) and
  the terminal states. Distinct from `sortie:needs-human`, which stays the **native**
  review-feedback escalation label — the two are kept separate on purpose.
- **Notify:** the `@scolacur` mention hits GitHub notifications directly; a repo→Discord
  webhook (Discord webhook URL + `/github`) forwards the comment to a channel — no bot.

### ask_human (Layer 2 — generic free-text; allowlist deferred)

Lets the agent ask a question and pause rather than guess. **Async, turn-based** (not
real-time), reusing Sortie's continuation dispatch:

- **Ask (agent side, in `WORKFLOW.md` prompt body):** the agent posts its question as an
  issue comment whose first line is `### ❓ ask_human`, leaves the tree clean (no PR), and
  self-relabels `sortie:in-progress → sortie:awaiting-human` (dropping out of the active
  set), then ends its turn.
- **Resume (inbound, `.github/workflows/sortie-ask-human.yml`):** `on: issue_comment` — when
  **`scolacur`** replies on an **`awaiting-human`** issue, it flips the label back to
  `sortie:queued`. Sortie re-dispatches; `before_run` reuses `sortie/<id>` (prior work
  intact); the prompt's "check for answers" step makes the agent read the issue thread for
  the reply. The bot's own question comment and the github-actions confirmation never
  trigger it (author ≠ owner), so no loop.
- **GitHub-first.** A later Discord phase only adds an *input adapter* — a Discord bot
  (needs message-read scope, NOT a webhook) that posts Steve's Discord reply as a GitHub
  comment, which triggers the same resume workflow. Detection stays unified on GitHub.
- **Egress-allowlist permission prompt is explicitly deferred** — its ideal home is the
  agent dashboard (a blocked-request log grouped by domain + a one-click "allowlist" button,
  on the NAS network where it can actually reach `squid.conf`), not a cloud Action (which
  can't reach the NAS), and the agent must never self-allowlist (defeats containment).

### Deploy + live-verify checklist (Layers 1 & 2)

- [x] Labels `sortie:stuck` + `sortie:awaiting-human` created (`gh label create`).
- [ ] Merge the two workflow files to `main` — Actions only run from the default branch's
  own copy. (The watchdog `cron` and the `issue_comment` trigger both need this.)
- [ ] Recreate the NAS container (egress compose) so the updated `WORKFLOW.md` prompt mounts.
- [ ] **Live-verify (needs a Sortie run — do when next exercising Sortie):**
  - The agent can run `gh` during its turn — i.e. `GH_TOKEN`/`SORTIE_GITHUB_TOKEN` is in the
    agent's env (the prompt `export`s it; confirm it resolves). If not, the ask/relabel fails.
  - Self-relabel to `awaiting-human` mid-/end-run doesn't get fought by the reconciler in a
    way that loses the park (issue should land + stay in `awaiting-human`).
  - On re-queue, the agent actually reads the human reply from the thread and continues
    rather than restarting.
- [ ] Set up the repo→Discord webhook for `@`-mention/question forwarding (Discord side).

---

## Quota-fail budget refund (janitor) — closes the quota-fail-consumes-budget gap

### The gap

`agent.max_sessions: 3` (in `WORKFLOW.md`) is enforced by **counting `run_history` rows
per `issue_id`** in `.sortie.db`. The docs confirm the semantics but not the failure
accounting — `agent.max_sessions` is *"Maximum completed sessions per issue before the
orchestrator stops retrying"* and `agent.max_tokens` *"sums the total_tokens recorded for
every session … stops dispatching … once the sum reaches a non-zero budget"*
(`reference/workflow-config`, `reference/adapter-claude-code`). Observed live: a run that
fails **solely** because the Anthropic Pro session quota was exhausted **still writes a
`run_history` row** (`status='failed'`, `error` contains `turn_failed: success`,
`total_tokens=0`). Three such instant-fails in ~2 minutes permanently cap an issue, and
when the Pro window resets the issue **stays capped and never retries**. Confirmed on #6.

### Native support? No — checked first (doc-grounded)

Checked `reference/workflow-config`, `reference/adapter-claude-code`, `reference/cli`, and
the repo README. Sortie has **no native knob** to (a) detect a usage/rate-limit failure or
(b) exempt it from `max_sessions` / back off until the limit resets:

- `agent.max_retry_backoff_ms` — *"Maximum delay cap for exponential backoff on retries"* —
  is generic retry scheduling; it does **not** distinguish a quota failure or stop it
  counting toward `max_sessions`.
- `ci_feedback.max_retries` / `reactions.review_comments.max_retries` are reaction caps,
  not agent-usage-limit handling.
- The "effort budget exhausted, blocking re-dispatch … max_sessions:3" and
  "cap_skipped:N" log lines are **internal strings**, not documented/configurable concepts
  (no `effort_budget` field exists in the docs). Do not configure against them.
- The HTTP API has **no write/reset endpoint** — only `POST /api/v1/refresh` (triggers a
  poll). The only supported way to reset the counter is editing the SQLite DB directly,
  exactly as the proven manual fix does.

So the fix is a **minimal external janitor** that automates the safe equivalent of the
manual reset, gated so it only fires after the quota window has actually reset.

### What `quota-refund.sh` does

A stateless, idempotent host-cron one-shot (no daemon):

1. **Liveness gate (anti-re-storm).** Before touching anything, it probes the coding agent
   with a one-word prompt **inside the running `sortie` container** (`docker exec … claude
   -p …`), inheriting the same `CLAUDE_CODE_OAUTH_TOKEN` Sortie uses. If the probe returns
   the usage-limit signature (`usage limit reached` / `hit your … limit` / `resets <time>`),
   the quota is **still out** → it does **nothing** and exits. Budget is refunded **only
   after the window has reset**, so a refund can never feed 3 fresh instant-fails. The probe
   is one trivial turn — far cheaper than a real session — and an inconclusive probe (no
   `ok`, no limit signature) is treated conservatively as "do nothing".
1a. **Idle guard (don't interrupt healthy work).** Step 3's refund `docker stop`s the
   container to quiesce the SQLite writer. Before any probe or stop, the script queries
   Sortie's **read-only** state API (`docker exec sortie sh -lc 'curl -s
   localhost:7678/api/v1/state'` — port 7678 is unpublished under the egress-isolated
   network, so it's reached from *inside* the container, same as the probe) and reads
   `counts.running`. If **any** run is in progress (`counts.running > 0`) it logs "agents
   active — deferring refund to next run" and exits **0 without stopping or refunding**.
   It defers on `running` only, not `retrying`: a retrying issue is in Sortie's backoff
   scheduler between attempts and isn't holding the single agent slot, so a stop doesn't
   interrupt live work for it. The count is parsed with `grep`/`tr` (no `jq` — not
   guaranteed on the DSM host), anchored on the `"counts":{…}` object so a `running` key
   elsewhere in the JSON can't be misread. **Fail-safe:** if the count can't be determined
   (exec/curl fails, empty or unparseable body) the script treats it as "possibly busy"
   and defers — it never stops on an ambiguous check. With `max_concurrent_agents: 1` this
   removes the narrow window where a refund (quota-cap exists AND quota just reset AND
   Sortie happens to be running *another* issue) would kill a healthy in-flight run and
   waste the session + tokens this janitor exists to protect.
   > **Residual caveat (best-effort, not airtight).** A few-second TOCTOU window remains:
   > Sortie could dispatch a new run between the idle check and the `docker stop`, because
   > its API is **read-only with no pause/maintenance mode** — there is no way to atomically
   > "hold runs, then stop". The guard shrinks the blast radius to negligible (it has to
   > coincide with the exact second a quota window reset *and* a new dispatch fires); it does
   > **not** eliminate it. If it ever does hit, the killed run is retried on restart exactly
   > as before this guard existed — so the guard is a strict improvement with no downside.
2. **Classification (precise).** It selects issues whose `run_history` is composed
   **entirely** of quota-fails. The SQL rule, per `issue_id`:
   - `SUM(quota_fail) > 0` — at least one quota-fail, **and**
   - `SUM(NOT quota_fail) = 0` — **zero** rows that are anything else,
   where `quota_fail` ⟺ `status='failed' AND error LIKE '%turn_failed: success%' AND
   total_tokens=0`.
3. **Refund (safe).** Stops the container (quiesces the SQLite writer), backs the DB up to
   `backups/.sortie.db.<UTC-stamp>.quota-refund.bak`, then in a single `BEGIN IMMEDIATE`
   transaction `DELETE`s only those issues' `run_history` + `session_metadata` rows, and
   restarts the container (via the `cleanup` EXIT trap, so it restarts even on error). This
   mirrors the proven manual procedure exactly. Re-queue the issue's label afterward (a
   re-queue alone does **not** clear counters — that's the whole point of this script).

### Failure-classification rule — and why #8 stays capped

| Issue | run_history rows | Refunded? |
|-------|------------------|-----------|
| **#6** | all `failed` / `turn_failed: success` / 0 tokens | **Yes** — pure quota loss |
| **#8** | 31× `failed` on an `after_create` **git clone exit-128** (stale workspace) | **No** — its error is not the quota signature, so `SUM(NOT quota_fail) > 0`; the cap holds |
| mixed | one quota-fail **plus** any real fail or any success | **No** — non-quota rows present |
| quota-text but `total_tokens>0` | agent actually ran, then hit a limit | **No** — tokens were spent; conservative |

The two classes are distinguished purely by the per-row signature: **#8's rows fail with a
git-clone error string and are not `turn_failed: success`/0-token**, so #8 always has
`SUM(NOT quota_fail) > 0` and is never selected. `max_sessions` storm-protection is fully
preserved — the cap still stops every genuinely-failing issue; this script only refunds
sessions **provably** lost to quota.

This was validated against a mock DB modeling #6, #8, a mixed issue, and the tokens>0 case;
the query returned **only #6 and the pure-quota issue**, leaving #8 and the mixed/tokens>0
issues capped.

### Why a liveness probe, not reset-time parsing

The Anthropic usage-limit error includes a reset time, but in **two** forms depending on
Claude Code version/auth: `Claude AI usage limit reached|<unix_ts>` (machine-parseable) and
`You've hit your limit · resets 4pm (Europe/Berlin)` / `· resets 5:20am (UTC)` (12-hour
clock + IANA tz, lossy to parse). Critically, the observed `run_history.error` column holds
**Sortie's `turn_failed: success` wrapper, not the raw Claude reset string** — and it is
**unconfirmed** that Sortie persists the reset timestamp anywhere in the DB. Rather than
parse a field that may not exist, the probe answers the only question that matters — *"has
the window reset?"* — directly and robustly, and the script's grep also recognizes both
reset-text forms in the probe output. If a future Sortie build is confirmed to store the
reset timestamp, gating on it would be a valid cheaper alternative.

### Re-storm bounding (why this can't loop)

- Refund happens **only** on a successful liveness probe (quota actually reset), so a refund
  never immediately re-fills with quota-fails.
- It is **idempotent**: once #6's rows are gone it's no longer "all quota-fail"; #8 is never
  eligible; running it repeatedly is a no-op.
- A single-instance lock (`flock`, or a `mkdir` fallback for busybox shells) prevents
  overlapping runs. Worst case per refund: a refund restores the issue's full budget, so it
  can re-dispatch up to **`max_sessions` (3)** times before re-capping — bounded per refund,
  and a refund only happens once the probe confirms the window reset (never while exhausted),
  so this can't tighten into a loop. If those retries quota-fail again, the issue re-caps and
  is only refunded on the *next* confirmed window reset — at most `max_sessions` retries per
  refund per window, not a perpetual storm.

### Deploy 🧑 (NAS host cron — NOT a GitHub Action)

Sortie runs on the egress-isolated `internal: true` network (no inbound; unreachable from
GitHub Actions or any external host), so the janitor **must** run on the NAS host. Host cron
is chosen over a sidecar because it runs in the host namespace where `docker stop/start` and
`/bin/sqlite3` are available without granting a container access to the Docker socket (which
would defeat the egress isolation).

1. The script ships in the repo clone at
   `/volume1/docker/personal-dashboard/personal-dashboard/ops/sortie/quota-refund.sh`
   (already present after `git pull`; no separate copy needed). Make it executable:
   ```sh
   chmod +x /volume1/docker/personal-dashboard/personal-dashboard/ops/sortie/quota-refund.sh
   ```
2. It uses these defaults (override via env in the cron line if your layout differs):
   `SORTIE_BASE_DIR=/volume1/docker/personal-dashboard`,
   `SORTIE_DB_PATH=$BASE/data/.sortie.db`, `SORTIE_CONTAINER=sortie`,
   `SORTIE_BACKUP_DIR=$BASE/backups`, `SQLITE_BIN=/bin/sqlite3`,
   `SORTIE_COMPOSE_FILE=$BASE/personal-dashboard/ops/sortie/docker-compose.egress.yml`.
3. Add a DSM host-cron entry (DSM → **Control Panel → Task Scheduler → Create → Scheduled
   Task → User-defined script**, run as a user that can `sudo docker`; schedule **hourly**).
   Script body:
   ```sh
   /volume1/docker/personal-dashboard/personal-dashboard/ops/sortie/quota-refund.sh \
     >> /volume1/docker/personal-dashboard/quota-refund.log 2>&1
   ```
   (Or a root crontab line: `0 * * * * /…/ops/sortie/quota-refund.sh >> /…/quota-refund.log 2>&1`.)
   Hourly is fine: the Pro window resets on a multi-hour cadence, the probe is cheap, and the
   liveness gate means off-window runs are instant no-ops.
4. **First run, dry of cron:** run it by hand once while a quota-cap exists and confirm the
   log shows either "quota STILL exhausted … refusing" (window not reset yet) or a refund +
   backup. Then re-queue the refunded issue's `sortie:queued` label.

### Recreate / restart implications

- The script `docker stop`s then `docker start`s the **same** container — this is a plain
  restart, **not** a recreate, so it does **not** re-read `WORKFLOW.md` or `sortie.env`
  (those are baked at create time). That's intended: the janitor only edits the DB on the
  host volume; it must not change Sortie's config. Config changes still follow the
  **recreate** path in Step 4.7.
- The DB and workspaces live on host volumes, so the stop/start preserves all other state.
- If you `docker compose down`/recreate the project for a config change, no janitor action is
  needed — the DB on the volume is untouched and the next hourly run still applies.

### `ANTHROPIC_API_KEY` alternative

If `sortie.env` is switched from the Pro `CLAUDE_CODE_OAUTH_TOKEN` to a metered
`ANTHROPIC_API_KEY` (no session-quota wall), the `turn_failed: success` / 0-token quota
signature should stop occurring, so this janitor becomes a harmless no-op (it never finds an
all-quota-fail issue) — leave it installed as a safety net. That switch is the cleaner fix
for the quota wall itself, but it trades the subscription cap for per-token billing and is
**not assumed here**; this script makes the current Pro-token setup self-healing without it.

### Deploy-time verification (flag)

- **Confirm the `run_history.error` text** on the live DB matches `%turn_failed: success%`
  for a real quota-fail before relying on the classifier (the signature is the *observed*
  one; refine `QUOTA_ERROR_LIKE` in the script only if a live inspection gives a tighter,
  still-safe match). `sqlite3 /…/data/.sortie.db "SELECT issue_id,status,error,total_tokens
  FROM run_history WHERE status='failed' LIMIT 20;"`
- **Confirm `claude -p` is the right probe invocation** for the installed Claude Code CLI
  (the `claude` binary is on PATH in the image per the Dockerfile; adjust the probe command
  if your CLI differs).
- **Confirm the `session_metadata` table exists** on the installed Sortie build — the refund
  transaction deletes from it. It's present on the current build (the manual reset used it),
  but if a future build drops/renames it the `DELETE` would roll back fail-safe (backup intact,
  container restarted) and refunds would silently never complete. Quick check:
  `sqlite3 /…/data/.sortie.db "SELECT name FROM sqlite_master WHERE type='table' AND name='session_metadata';"`
- **Confirm `bash` exists on the DSM host** at the script's shebang path; the script avoids
  `mapfile`/guarantees a `flock`-or-`mkdir` lock fallback for older/busybox shells, but the
  shebang is `#!/usr/bin/env bash`. If the host only has `/bin/sh`, invoke via `bash
  /…/quota-refund.sh` in the cron line.
