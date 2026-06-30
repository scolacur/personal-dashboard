---
# Sortie workflow config for the Personal Dashboard autonomous loop.
# YAML front-matter = runtime config. Body below the closing `---` = the Go
# text/template prompt handed to the coding agent for each issue.
#
# Mounted read-only into the container at /home/sortie/WORKFLOW.md.
# Secrets are NEVER in this file — only $ENV references, resolved at runtime.
#
# ⚠ CONFIRM against your installed Sortie version's `reference/workflow-config`
#   and `guides/setup-workspace-hooks` — a few field names below (esp. the
#   after_run PR hook) are not fully shown in the public docs and are flagged.

tracker:
  kind: github
  api_key: $SORTIE_GITHUB_TOKEN          # bot account's classic PAT (public_repo)
  project: $SORTIE_GITHUB_PROJECT         # scolacur/personal-dashboard
  # AUTHORIZATION GATE: only fetch issues already in an active state. The repo is PUBLIC
  # (anyone can open an issue) but only write+ collaborators can apply labels — so an
  # unlabeled stranger issue never matches and never runs. Must include BOTH active labels
  # (comma = OR in GitHub search), or the reconciler drops the issue the moment the agent
  # flips it to in-progress.
  query_filter: 'label:"sortie:queued","sortie:in-progress"'
  # Labels MUST be pre-created in the repo — the adapter does not auto-create them.
  # active_states = states a worker should be running for. in_progress_state MUST be
  # included here, or the reconciler cancels the worker the moment the agent flips the
  # issue to in-progress.
  active_states: ["sortie:queued", "sortie:in-progress"]
  in_progress_state: "sortie:in-progress"   # set when the agent starts
  terminal_states: ["sortie:done", "sortie:wontfix"]
  # After a SUCCESSFUL run, Sortie moves the issue here — OUT of active_states and out of
  # query_filter — so it is NOT re-dispatched while its PR awaits review. Without this, a
  # merged issue stays "active" and gets re-run, opening duplicate PRs + burning quota.
  # Must not appear in active_states or terminal_states. Re-label to sortie:queued to re-run.
  handoff_state: "sortie:in-review"

polling:
  interval_ms: 30000                       # poll every 30s

workspace:
  root: /home/sortie/workspaces            # per-issue dir created under here; isolated, no path to /core

agent:
  kind: claude-code
  command: claude
  max_turns: 50
  max_concurrent_agents: 1                  # PILOT: one ticket at a time
  # --- TOKEN-BURN BOUNDARIES (default for both is 0 = UNLIMITED — that's how #6/#8 hit attempt 43) ---
  max_sessions: 3                           # HARD retry cap: stop dispatching an issue after 3 sessions.
                                            # NOTE: a quota-exhausted run still writes a run_history row and
                                            # counts here, permanently capping an issue when the Anthropic Pro
                                            # window resets. There is NO native knob to exempt it. The NAS
                                            # host-cron janitor ops/sortie/quota-refund.sh refunds ONLY
                                            # provably-quota-lost sessions once the window resets — it does NOT
                                            # raise/remove this cap and leaves real failures (e.g. #8) capped.
                                            # See README "Quota-fail budget refund".
  max_tokens: 3000000                       # per-issue cumulative token ceiling (belt across sessions; tune down once real usage is known)

# Claude Code adapter pass-through. Per-SESSION USD cap — meaningful on an API key; on the
# Pro OAuth token cost is subscription-quota (not $), so max_sessions/max_tokens are what bind.
claude-code:
  max_budget_usd: 5

# Self-Review (floor #6): runs inside the worker BEFORE push/PR. Reviewer "same"
# (the coding session itself, only supported value). It corrects locally up to
# max_iterations; it does not hard-block the PR. verification_commands is the
# Dashboard's existing aggregate gate.
self_review:
  enabled: true
  reviewer: "same"
  max_iterations: 3
  verification_commands:
    - "npm ci"
    - "npm run verify"                      # build && typecheck && lint && test (41 vitest tests)
  verification_timeout_ms: 180000

# ─── PR REACTIONS: change-requested → re-work (BEHAVIOR 1, NATIVE) ──────────────
# Source: reference/reactions + guides/configure-review-feedback + reference/workflow-config.
# `reactions` is a MAP of named reaction kinds (NOT `enabled: bool` — that's why the
# earlier `enabled: true` failed with "expected map, got bool"). We enable ONLY
# review_comments. How it works:
#   • Trigger: a human "Request changes" (reviewDecision CHANGES_REQUESTED) review on
#     the issue's PR. Bot/automated comments are filtered out by the adapter.
#   • Dispatch: a CONTINUATION turn in the SAME existing workspace + branch (it pushes
#     fixes onto the existing PR). It does NOT relabel the issue — reactions fire while
#     the issue sits in handoff_state (sortie:in-review). See README "Follow-ups" for why
#     we deliberately do NOT flip the label back to in-progress for the review path.
#   • PR lookup: requires .sortie/scm.json (written by the after_run hook above).
# Loop bounding (so we can't re-storm like attempt 43):
#   • fingerprint = sorted set of non-outdated comment IDs; an unchanged review is
#     skipped (deduplicated) — it only re-dispatches when the comment set CHANGES.
#   • debounce_ms waits after the newest comment before dispatching (batches edits).
#   • max_continuation_turns is the hard ceiling on review-triggered continuations.
#   • per-issue agent.max_sessions / max_tokens still bind across everything.
# NOTE: `reactions` values are NOT env-expanded (per reference/workflow-config), so
# `provider` is the literal "github".
# ⚠ CONFIRM at deploy against your installed version's reference/reactions: the
#   sub-field names below (poll_interval_ms / debounce_ms / max_continuation_turns)
#   are from the current public docs; older builds may differ.
reactions:
  review_comments:
    provider: github
    poll_interval_ms: 120000        # min 30000; poll PR review state every 2m
    debounce_ms: 60000              # wait 60s after newest comment before dispatch
    max_continuation_turns: 3       # hard cap on review-triggered re-works
    max_retries: 2
    escalation: label               # on cap-exhaustion, label for a human
    escalation_label: "sortie:needs-human"   # MUST be pre-created in the repo
  # NOTE: merge-conflict (CONFLICTING/DIRTY) is NOT a native reaction kind — Sortie's
  # auto_merge only acts on clean/unstable PRs and no reaction detects DIRTY. Behavior 2
  # is therefore handled by an in-repo bridge: .github/workflows/sortie-conflict-rework.yml
  # flips the issue label back into the active set so Sortie re-dispatches a normal run
  # (which then merges origin/main per the prompt body). See README "Follow-ups".

hooks:
  # Clone the Dashboard ONLY into the isolated workspace. Token-in-URL because
  # hooks run in a restricted env (only system + SORTIE_* vars; SORTIE_GITHUB_TOKEN
  # is available). No SSH keys, no path to /core.
  #
  # IDEMPOTENCY (the exit-128 fix): the workspaces volume is PERSISTENT
  # (docker-compose: /volume1/.../workspaces:/home/sortie/workspaces) and the dir is
  # named by issue id. On any re-dispatch (conflict re-work, re-queue, retry) the dir
  # `workspaces/<id>` already exists and is non-empty from the prior run; Sortie's
  # rollback does NOT rm it. A bare `git clone` into a non-empty dir is
  # `fatal: destination path already exists` → exit 128, which then loops forever on
  # the worker's prep-retry backoff (this stuck #6 and #8). So wipe first, then clone.
  # Safe: the workspace is disposable — source of truth is origin, and before_run
  # re-fetches `sortie/<id>` from origin on every attempt.
  after_create: |
    rm -rf "$SORTIE_WORKSPACE"
    git clone "https://x-access-token:${SORTIE_GITHUB_TOKEN}@github.com/scolacur/personal-dashboard.git" "$SORTIE_WORKSPACE"

  # BRANCH REUSE (follow-up correctness): before_run re-runs on every attempt —
  # retries, review-feedback continuations, and conflict re-activations alike
  # (reference/workflow-config: "before_run — runs before each agent attempt").
  # A blind `checkout -B sortie/<id> origin/main` would DISCARD the PR's existing
  # commits on any follow-up. So: if the remote branch already exists, fetch and
  # check it OUT (preserving its history); only create from main on first attempt.
  # The conflict-resolution merge of origin/main is left to the agent (see prompt
  # body) so the worker can actually resolve conflicts rather than the hook failing.
  before_run: |
    cd "$SORTIE_WORKSPACE"
    git fetch origin main
    BRANCH="sortie/${SORTIE_ISSUE_IDENTIFIER}"
    if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      echo "follow-up: reusing existing remote branch $BRANCH"
      git fetch origin "$BRANCH"
      git checkout -B "$BRANCH" "origin/$BRANCH"
    else
      echo "first attempt: creating $BRANCH from origin/main"
      git checkout -B "$BRANCH" origin/main
    fi

  # Commit, push, open a PR AS THE BOT. The bot PAT has Contents+PRs write but is
  # non-admin and branch protection requires 1 approval -> it cannot self-merge.
  # ⚠ The docs don't show a PR-creation hook; this is the standard gh pattern —
  #    confirm gh is on PATH (it is, via the Dockerfile) and the flags match.
  after_run: |
    cd "$SORTIE_WORKSPACE"
    git config user.name  "sortie-bot-55"
    git config user.email "297784052+sortie-bot-55@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then echo "no changes; skipping PR"; exit 0; fi
    git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes"
    git push -u origin "sortie/${SORTIE_ISSUE_IDENTIFIER}"
    export GH_TOKEN="$SORTIE_GITHUB_TOKEN"
    REVIEW_NOTE=""
    if [ -n "$SORTIE_SELF_REVIEW_SUMMARY_PATH" ] && [ -f "$SORTIE_SELF_REVIEW_SUMMARY_PATH" ]; then
      REVIEW_NOTE="$(cat "$SORTIE_SELF_REVIEW_SUMMARY_PATH")"
    fi
    # "Closes #N" so merging the PR auto-closes the issue (belt-and-suspenders terminal
    # transition alongside handoff_state — a closed issue also drops out of candidates).
    PR_BODY=$(printf 'Closes #%s\n\nAutomated by Sortie for #%s. Self-review: %s.\n\n%s' "$SORTIE_ISSUE_IDENTIFIER" "$SORTIE_ISSUE_IDENTIFIER" "$SORTIE_SELF_REVIEW_STATUS" "$REVIEW_NOTE")
    BRANCH="sortie/${SORTIE_ISSUE_IDENTIFIER}"
    # On a FOLLOW-UP the PR already exists, so `gh pr create` errors — that's fine,
    # the push above already updated it. `|| true` keeps the hook from failing, and
    # we resolve the PR number afterward either way.
    gh pr create \
      --repo scolacur/personal-dashboard \
      --base main \
      --head "$BRANCH" \
      --title "sortie: resolve #${SORTIE_ISSUE_IDENTIFIER}" \
      --body "$PR_BODY" || true
    # ─── .sortie/scm.json (REQUIRED by reactions) ────────────────────────────────
    # guides/configure-review-feedback + reference/reactions: review_comments &
    # ci_failure reactions read .sortie/scm.json to locate the PR; the after_run
    # hook (or agent) must write pr_number(int)/owner/repo, plus branch+sha which
    # ci_failure/auto_merge use. Without this file NO reaction can find the PR, so
    # the change-requested follow-up loop never fires. Resolve the PR number for the
    # head branch (works for both freshly-created and pre-existing follow-up PRs).
    PR_NUMBER="$(gh pr view "$BRANCH" --repo scolacur/personal-dashboard --json number --jq .number 2>/dev/null || echo "")"
    SHA="$(git rev-parse HEAD)"
    mkdir -p "$SORTIE_WORKSPACE/.sortie"
    if [ -n "$PR_NUMBER" ]; then
      printf '{"pr_number":%s,"owner":"scolacur","repo":"personal-dashboard","branch":"%s","sha":"%s"}\n' \
        "$PR_NUMBER" "$BRANCH" "$SHA" > "$SORTIE_WORKSPACE/.sortie/scm.json"
    else
      echo "WARN: could not resolve PR number for $BRANCH; reactions will not activate" >&2
    fi

db_path: /home/sortie/.sortie.db
---

# Working on #{{ .issue.identifier }}: {{ .issue.title }}

{{ .issue.description }}

{{ if .run.is_continuation }}
---

## ⚠ THIS IS A REVIEW-FEEDBACK FOLLOW-UP — not a first attempt

A human reviewed your PR and **requested changes**. You are continuing on the
**existing branch** `sortie/{{ .issue.identifier }}` with your prior commits intact —
do NOT start over and do NOT recreate the PR. Address the review, then commit and push;
the existing PR updates automatically.

Review comments to resolve:
{{ range .review_comments }}
- **{{ .reviewer }}** on `{{ .file }}` (lines {{ .start_line }}–{{ .end_line }}):
  {{ .body }}
{{ else }}
- (No structured review comments were passed; read the PR conversation directly with
  `gh pr view {{ .issue.identifier }} --comments` and address every "Request changes" point.)
{{ end }}

Re-run `npm run verify` after your fixes. Do not weaken tests to make review feedback pass.
The "reconcile with main" step below still applies if the branch also drifted from `main`.
{{ end }}

---

## First: reconcile with `main` if this branch already has work

The branch `sortie/{{ .issue.identifier }}` may already contain commits from a previous
PR for this issue (a re-activated conflict re-work arrives as a normal dispatch, so the
`is_continuation`/retry banners above may NOT show even though the branch is non-empty).
Before doing anything else, make the branch mergeable into `main`:

```sh
git fetch origin main
git merge origin/main   # if this reports conflicts, resolve them, git add, git commit
```

Keep BOTH the PR's intent and `main`'s changes when resolving. Never discard the branch's
existing commits or recreate the branch/PR. Then proceed with the issue below.

## How to work in this repo

- This is the **Personal Dashboard** — a TypeScript npm-workspaces monorepo
  (`apps/web` SvelteKit, `apps/server` Fastify + better-sqlite3, `packages/shared`).
- **Prefer the codebase's existing conventions** over introducing new ones. When a
  decision isn't obvious, match the nearest existing pattern. Read `CLAUDE.md`,
  `PROJECT.md`, and `DECISIONS.md` before making structural choices.
- **Verify your work** with `npm run verify` (build + typecheck + lint + test).
  Do not weaken or delete tests to make it pass.

## Scope discipline (you are running unattended)

- Stay within the scope of this one issue. Do not refactor unrelated code.
- **Document every assumption you make** under an `## Assumptions` header in the PR
  description, so a human can check them.
- **Do NOT touch** secrets/`.env*`, auth/session code, CI/Dockerfiles,
  `package.json` scripts, dependencies, or the DB schema. If the issue seems to
  require any of these, stop and say so in the PR rather than doing it.
- If a change would affect more than a few files or feels larger than the ticket,
  open the PR as a draft and flag it prominently.
