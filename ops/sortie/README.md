# Sortie setup — Personal Dashboard autonomous loop

Deploy + configuration runbook. Files in this dir:

- `Dockerfile` — Sortie + Claude Code + `git`/`gh` (hooks need the latter two).
- `WORKFLOW.md` — Sortie config (tracker, hooks, self-review, reactions) + the agent prompt template.
- `README.md` — this runbook.
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
