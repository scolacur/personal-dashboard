# Sortie setup — Personal Dashboard autonomous loop

Deploy + configuration runbook. Files in this dir:

- `Dockerfile` — Sortie + Claude Code + `git`/`gh` (hooks need the latter two).
- `WORKFLOW.md` — Sortie config (tracker, hooks, self-review) + the agent prompt template.
- `README.md` — this runbook.

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

> The GitHub *adapter* only reads issues + manages labels. Branch/PR creation is done
> by the *workspace hooks* in `WORKFLOW.md` — that's where the bot token is used.

---

## Step 1 — Bot identity 🧑

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

## Step 2 — Branch-protection cutover 🤖 (Tank runs once the bot is a collaborator)

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

## Step 3 — Pre-create the issue labels 🤖 (Tank runs)

The adapter does not create labels. Needed: `sortie:queued`, `sortie:in-progress`,
`sortie:done`, `sortie:wontfix`. Tank will run `gh label create …` for each.

## Step 4 — Build + deploy on the NAS 🧑

1. Get `ops/sortie/Dockerfile` + `ops/sortie/WORKFLOW.md` onto the NAS (clone the repo
   or copy the dir). Edit the bot noreply email in `WORKFLOW.md` if not already done.
2. Build the image (Container Manager or SSH):
   `docker build -f ops/sortie/Dockerfile -t sortie-dashboard .`
3. Create the container with:
   - **Env:** `ANTHROPIC_API_KEY`, `SORTIE_GITHUB_TOKEN` (bot PAT),
     `SORTIE_GITHUB_PROJECT=scolacur/personal-dashboard`.
   - **Volumes:** `sortie-data:/home/sortie` (SQLite persistence),
     `./workspaces:/home/sortie/workspaces`,
     `./WORKFLOW.md:/home/sortie/WORKFLOW.md:ro`.
   - **Port:** `7678:7678`.
   - DSM note: the `--init` flag may be unavailable in Container Manager — omit it; not
     required. No privileged mode / caps needed.
4. Decide **which Synology user** runs the container (open deploy decision).
5. Health check: `curl http://<nas>:7678/readyz` → ready.

## Step 5 — First pilot ticket 🧑/🤖

The pilot issue already exists: **#2 "Home: empty-state when no widgets registered"**
(pure `+page.svelte` UI, D-017 acceptance shape, touches none of the forbidden areas).

- 🤖 Tank adds the `sortie:queued` label to #2 on your go.
- 🧑 Watch Sortie pick it up (logs / `GET :7678/api/v1/state`), let it open the PR,
  review + approve + merge.

---

## Open decisions (yours)

- Bot account name + email (Step 1).
- Which Synology user runs Sortie; persistent volume layout / env-file location (Step 4).
- Per-ticket cost/duration budget (soft-block) — tune after the first real run.
- Concurrency stays at **1** for the pilot (set in `WORKFLOW.md`).

## Flagged / confirm against your Sortie version

- The `after_run` **PR-creation hook** is the standard `gh pr create` pattern — the
  public docs show clone/branch/commit hooks but not a PR hook. Confirm against
  `guides/setup-workspace-hooks` for your version.
- Startup token/project env var names: the Docker guide uses `SORTIE_GITHUB_TOKEN` /
  `SORTIE_GITHUB_PROJECT`; the environment reference also lists generic
  `SORTIE_TRACKER_API_KEY` / `SORTIE_TRACKER_PROJECT`. `WORKFLOW.md` references the
  former via `$`-expansion — confirm your version resolves them.
- `reactions` block fields — enabled only; see `guides/pr-reactions` if you want to tune.
