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
  # Container-LOCAL (overlay fs), deliberately NOT a NAS bind-mount — workspaces are
  # disposable (origin is source of truth; before_run re-fetches and regenerates scm.json).
  # Wiped on --force-recreate, so deploys start clean and node_modules don't pile up on the
  # NAS. The after_create `rm -rf` still handles within-run re-dispatch idempotency.
  root: /tmp/sortie-workspaces             # per-issue dir created under here; isolated, no path to /core

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
  #
  # PROXY (egress fix): under the egress-hardened deploy Sortie sits on an internal network
  # with NO direct internet — the only route out is the squid sidecar. Hooks run in an env
  # where an `export http(s)_proxy=...` does NOT take effect for git (an inherited uppercase
  # HTTPS_PROXY wins, or the export isn't applied), so git hangs and exits 128 — this re-broke
  # #6/#8 after the container was recreated onto egress_internal. FIX: pass the proxy directly
  # on each network git command via `-c http.proxy=` (git config overrides all proxy env vars;
  # http.proxy covers https remotes too), and inline the proxy env on `gh`. Hostname matches
  # docker-compose.egress.yml's egress-proxy:3128.
  after_create: |
    # cd OUT of the workspace BEFORE removing it. Sortie runs this hook with CWD set to
    # $SORTIE_WORKSPACE, so `rm -rf "$SORTIE_WORKSPACE"` deletes the shell's own working
    # directory; `git clone` then calls getcwd() at startup, finds CWD gone, and dies with
    # `fatal: Unable to read current working directory: No such file or directory` (exit 128
    # in ~0.2s). This is a THIRD distinct exit-128 cause, separate from the non-empty-dir
    # (the rm itself) and proxy fixes. /home/sortie is a stable dir outside the workspace
    # (the bind-mounted home); before_run does its own `cd "$SORTIE_WORKSPACE"` afterward.
    cd /home/sortie 2>/dev/null || cd /
    rm -rf "$SORTIE_WORKSPACE"
    git -c http.proxy=http://egress-proxy:3128 clone "https://x-access-token:${SORTIE_GITHUB_TOKEN}@github.com/scolacur/personal-dashboard.git" "$SORTIE_WORKSPACE"

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
    PX=http://egress-proxy:3128
    git -c http.proxy=$PX fetch origin main
    BRANCH="sortie/${SORTIE_ISSUE_IDENTIFIER}"
    if git -c http.proxy=$PX ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
      echo "follow-up: reusing existing remote branch $BRANCH"
      git -c http.proxy=$PX fetch origin "$BRANCH"
      git checkout -B "$BRANCH" "origin/$BRANCH"
      # Regenerate .sortie/scm.json in the freshly-cloned workspace. after_create did
      # `rm -rf`, so any scm.json the prior run wrote is gone from THIS workspace; it is
      # NOT committed to the branch. This covers the case where Sortie reads scm.json from
      # the cloned workspace at/after dispatch (vs. from the persistent pre-wipe workspace).
      # Only on the follow-up path — a first attempt has no PR yet. Harmless if redundant.
      PR_NUMBER="$(GH_TOKEN="$SORTIE_GITHUB_TOKEN" HTTPS_PROXY=$PX HTTP_PROXY=$PX gh pr view "$BRANCH" --repo scolacur/personal-dashboard --json number --jq .number 2>/dev/null || echo "")"
      if [ -n "$PR_NUMBER" ]; then
        mkdir -p "$SORTIE_WORKSPACE/.sortie"
        printf '{"pr_number":%s,"owner":"scolacur","repo":"personal-dashboard","branch":"%s","sha":"%s"}\n' \
          "$PR_NUMBER" "$BRANCH" "$(git rev-parse HEAD)" > "$SORTIE_WORKSPACE/.sortie/scm.json"
        echo "regenerated .sortie/scm.json for PR #$PR_NUMBER"
      fi
    else
      echo "first attempt: creating $BRANCH from origin/main"
      git checkout -B "$BRANCH" origin/main
    fi

  # ─── SAFETY-NET ONLY (P1 fix, 2026-06-30) ───────────────────────────────────────
  # The AGENT now does the durable hand-off (commit → push → gh pr create → write
  # .sortie/scm.json → relabel sortie:in-review) DURING its turn — see the prompt body
  # "Finish" section. Reason: on a needs-human-review exit Sortie cancels the worker
  # context, which races and kills BOTH this hook mid-run AND the handoff label
  # transition (`context canceled`), so a hook-authored PR landed with no scm.json and
  # the issue with no label. Doing it in-turn runs under a stable context + full env.
  #
  # This hook is now a BACKSTOP for a turn that died after committing but before
  # finishing push/PR/scm.json. It MUST be fully idempotent and MUST NOT fail the run:
  # on the normal path (agent already pushed + wrote scm.json) it detects that and
  # exits 0 without doing anything. It does NOT relabel — the agent self-relabels and
  # the in-repo sortie-watchdog "label-rescue" job backstops the label specifically.
  after_run: |
    cd "$SORTIE_WORKSPACE"
    PX=http://egress-proxy:3128
    BRANCH="sortie/${SORTIE_ISSUE_IDENTIFIER}"
    git config user.name  "sortie-bot-55"
    git config user.email "297784052+sortie-bot-55@users.noreply.github.com"
    # Commit any stragglers the agent left uncommitted (no-op if the tree is clean).
    git add -A
    git commit -m "sortie(${SORTIE_ISSUE_IDENTIFIER}): automated changes" 2>/dev/null || echo "nothing new to commit"
    # If there is no commit at all on this branch beyond main, there is nothing to hand off.
    if ! git rev-parse HEAD >/dev/null 2>&1; then echo "no HEAD; nothing to do"; exit 0; fi
    LOCAL="$(git rev-parse HEAD)"
    REMOTE="$(git -c http.proxy=$PX ls-remote origin "$BRANCH" 2>/dev/null | awk '{print $1}')"
    # NORMAL PATH: agent already pushed this exact commit AND wrote scm.json -> no-op.
    if [ "$LOCAL" = "$REMOTE" ] && [ -f "$SORTIE_WORKSPACE/.sortie/scm.json" ]; then
      echo "agent completed hand-off in-turn (remote up to date + scm.json present); safety-net no-op"
      exit 0
    fi
    echo "safety-net: agent did not finish hand-off (remote=$REMOTE local=$LOCAL); completing it"
    git -c http.proxy=$PX push -u origin "$BRANCH" || true
    # "Closes #N" so merging the PR auto-closes the issue (a closed issue also drops out
    # of candidates, belt-and-suspenders alongside the in-review hand-off).
    PR_BODY=$(printf 'Closes #%s\n\nAutomated by Sortie for #%s (completed by the after_run safety-net — the agent turn ended before finishing hand-off).' "$SORTIE_ISSUE_IDENTIFIER" "$SORTIE_ISSUE_IDENTIFIER")
    # Derive the title from the agent's last commit subject (now a descriptive
    # conventional-commit message, per the Finish step) so even the fallback PR is
    # informative. Only fall back to the generic title if there's no commit subject.
    TITLE="$(git log -1 --pretty=%s 2>/dev/null)"
    [ -z "$TITLE" ] && TITLE="sortie: resolve #${SORTIE_ISSUE_IDENTIFIER}"
    GH_TOKEN="$SORTIE_GITHUB_TOKEN" HTTPS_PROXY=$PX HTTP_PROXY=$PX gh pr create \
      --repo scolacur/personal-dashboard \
      --base main \
      --head "$BRANCH" \
      --title "$TITLE" \
      --body "$PR_BODY" || true
    PR_NUMBER="$(GH_TOKEN="$SORTIE_GITHUB_TOKEN" HTTPS_PROXY=$PX HTTP_PROXY=$PX gh pr view "$BRANCH" --repo scolacur/personal-dashboard --json number --jq .number 2>/dev/null || echo "")"
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

---

## STEP 0 — Are you continuing existing work? Check for an open PR on your branch.

**Do NOT trust any "continuation" banner or assume this is a first attempt.** Review-feedback
and conflict-rework dispatches arrive looking exactly like a fresh run (Sortie's
`is_continuation` is false for them), so the reliable signal is whether a PR already exists
for your branch. Run this FIRST, before any work:

```sh
export GH_TOKEN="$SORTIE_GITHUB_TOKEN"
BRANCH="sortie/{{ .issue.identifier }}"
PR=$(gh pr view "$BRANCH" --repo scolacur/personal-dashboard --json number --jq .number 2>/dev/null || true)
echo "existing PR: ${PR:-none}"
```

**If `$PR` is set, this is a FOLLOW-UP — not a first attempt.** Your prior commits are on the
branch. Do NOT start over, do NOT recreate the PR, do NOT duplicate prior work.

1. **Read ALL the feedback.** A top-level "Request changes" *summary* is NOT shown by
   `gh pr view --comments`, so fetch reviews explicitly:
   ```sh
   # summary review bodies (the "Request changes" text itself):
   gh api "repos/scolacur/personal-dashboard/pulls/$PR/reviews" \
     --jq '.[] | select(.state=="CHANGES_REQUESTED" or .state=="COMMENTED") | "[\(.state)] \(.user.login): \(.body)"'
   # inline review comments, with file + line:
   gh api "repos/scolacur/personal-dashboard/pulls/$PR/comments" \
     --jq '.[] | "\(.path):\(.line // .original_line): \(.body)"'
   # full conversation:
   gh pr view "$PR" --repo scolacur/personal-dashboard --comments
   ```
2. **See what you already changed**, so you EDIT it rather than pile on more:
   ```sh
   git fetch origin main
   git log --oneline origin/main..HEAD
   git diff origin/main
   ```
3. **Address every requested change by editing your existing work.** If the reviewer says
   "there should be only one X" or "change A to B", make the diff end in exactly that state —
   modify or remove what you added before; do NOT append yet another change. Then re-run
   `npm ci && npm run verify`. Do NOT weaken or delete tests to make feedback pass.

**If `$PR` is empty, this is a first attempt** — proceed normally with the issue below.

{{ if .review_comments }}
Structured review comments Sortie passed for this run (treat as authoritative locations):
{{ range .review_comments }}
- **{{ .reviewer }}** on `{{ .file }}` (lines {{ .start_line }}–{{ .end_line }}): {{ .body }}
{{ end }}
{{ end }}

---

## Before anything else: check for answers to a question you asked (ask_human)

Issue comments are NOT included above, and you may have asked the human a question on a
previous turn. **First, read the issue conversation:**

```sh
export GH_TOKEN="$SORTIE_GITHUB_TOKEN"
gh issue view {{ .issue.identifier }} --repo scolacur/personal-dashboard --comments
```

If you find a `### ❓ ask_human` question you posted earlier with a human reply beneath it,
treat that reply as the decision and continue the work. **Do not ask the same question
again.** If there is no such exchange, this is a normal run — proceed.

---

## First: reconcile with `main` if this branch already has work

The branch `sortie/{{ .issue.identifier }}` may already contain commits from a previous PR
for this issue (if STEP 0 found an existing PR, it definitely does). Before doing anything
else, make the branch mergeable into `main`:

```sh
git fetch origin main
git merge origin/main   # if this reports conflicts, resolve them, git add, git commit
```

Keep BOTH the PR's intent and `main`'s changes when resolving. Never discard the branch's
existing commits or recreate the branch/PR. Then proceed with the issue below.

## How to work in this repo

- This is the **Personal Dashboard** — a TypeScript npm-workspaces monorepo
  (`apps/web` SvelteKit, `apps/server` Fastify + better-sqlite3, `packages/shared`).
- **Orient before you code.** Read these first — they are the source of truth and
  override your own defaults:
  - `PROJECT.md` — scope, architecture, the stack, and the widget convention.
  - `CLAUDE.md` — the repo working agreement.
  - `DECISIONS.md` — *why* the codebase is the way it is. If an approach surprises
    you, the reasoning is probably here; check it before fighting a convention.
  - The nearest existing code to what you're touching — match its patterns.
- **Prefer the codebase's existing conventions** over introducing new ones. When a
  decision isn't obvious, match the nearest existing pattern rather than inventing one.
- **Log architectural decisions.** If you make a non-obvious design choice — picking
  between two valid approaches, introducing a pattern, adding a dependency, or shaping a
  schema/API contract — append a short entry to `DECISIONS.md` (what you decided, the
  alternatives, and why) **in this same PR**. This is how the next agent or human
  understands your reasoning without re-deriving it. One or two lines is fine; skip it
  only for mechanical changes with no judgement involved.
- **Verify your work** with `npm run verify` (build + typecheck + lint + test).
  Do not weaken or delete tests to make it pass.

## Tests — REQUIRED for feature/logic work (applies to follow-ups too)

The repo uses **vitest** (`npm run test`, part of `npm run verify`). Sortie-authored changes
must ship with tests.

- **Any new or changed business logic** — functions, route handlers, matchers, parsers,
  utilities, anything in `packages/shared` or `apps/server` with non-trivial behavior — MUST
  have unit tests covering it (happy path + the edge cases you can foresee). Co-locate them
  the way existing tests are (`*.test.ts` / `*.spec.ts`, matching the nearest example).
- **Self-check before you open OR update the PR:** walk your `git diff origin/main` and, for
  every new/changed unit of logic, confirm a corresponding test exists. If testable logic
  has no test, add it — treat untested logic as **incomplete**, not done.
- **This applies to continuation commits too:** if review feedback makes you add or change
  logic, add or adjust its tests in the same push.
- **Allowed to skip a test only when there's genuinely nothing to unit-test** — pure
  config, docs, type-only changes, or a presentational Svelte component with no logic. When
  you skip, say which change and why in the PR body.
- Never weaken, skip (`.skip`/`.only`), or delete existing tests to get `verify` green.

## Scope discipline (you are running unattended)

- Stay within the scope of this one issue. Do not refactor unrelated code.
- **Document every assumption you make** under an `## Assumptions` header in the PR
  description, so a human can check them.
- **Do NOT touch** secrets/`.env*`, auth/session code, CI/Dockerfiles,
  `package.json` scripts, dependencies, or the DB schema. If the issue seems to
  require any of these, prefer `ask_human` (below) over guessing or doing it anyway.
- If a change would affect more than a few files or feels larger than the ticket,
  open the PR as a draft and flag it prominently.

## ask_human — ask a question and pause instead of guessing

You are unattended, but you can hand a decision back to the human and pause rather than
guess. Use this when proceeding needs a judgement the issue doesn't answer: an ambiguous
API contract, two valid designs that diverge, or work that would touch the forbidden areas
above. Prefer asking over a risky assumption.

To ask:
1. Post the question as an issue comment whose **first line is exactly** `### ❓ ask_human`
   (this marker is how it's spotted and forwarded to the human). Be specific and, where you
   can, offer concrete options (A / B / …) so the reply can be short:
   ```sh
   export GH_TOKEN="$SORTIE_GITHUB_TOKEN"
   gh issue comment {{ .issue.identifier }} --repo scolacur/personal-dashboard --body "$(printf '### ❓ ask_human\n\n<your question + options>')"
   ```
2. Leave the working tree CLEAN — do not commit speculative work and do not open a PR.
3. Hand the issue back and stop. This drops it out of Sortie's active set so you are not
   re-dispatched while waiting; when the human replies you are re-dispatched automatically:
   ```sh
   gh issue edit {{ .issue.identifier }} --repo scolacur/personal-dashboard \
     --remove-label "sortie:in-progress" --add-label "sortie:awaiting-human"
   ```
Then end your turn. Do not poll or wait in-process.

---

## Finish: verify, push, open your PR, and hand off — DO THIS YOURSELF, in this turn

**Why this is your job, not a hook's.** When you finish, Sortie tears down the worker
context, which races with and can kill the post-run hook mid-execution (`context
canceled`) — leaving a PR with no `.sortie/scm.json` and an issue with no label, invisible
to review automation. So the durable steps below run **inside your turn**, while the
context and full environment (proxy, token) are alive. The hook is now only a backstop.

Once the work is complete and you are ready to hand off for human review, run these steps
**in order**. Do not skip the ordering — the relabel MUST be last (see step 6).

```sh
export GH_TOKEN="$SORTIE_GITHUB_TOKEN"
PX=http://egress-proxy:3128                      # egress proxy; git/gh have no direct internet
BRANCH="sortie/{{ .issue.identifier }}"
cd "$SORTIE_WORKSPACE"
```

1. **Final verify gate.** The workspace is a fresh clone with **no `node_modules`**, so
   install deps first, then verify:
   ```sh
   npm ci            # reaches registry.npmjs.org via the egress proxy (already allowlisted)
   npm run verify    # build + typecheck + lint + test
   ```
   Make `verify` pass. Do NOT weaken or delete tests to get there. If it cannot pass and you
   cannot fix it within scope, prefer `ask_human` over shipping a red PR. (`npm` honors the
   `HTTPS_PROXY` already set in your env — no extra proxy config needed.)

2. **Commit everything** with a clear, descriptive message in conventional-commit style (the
   same summary you'll use for the PR title — e.g. `feat(music-tracker): add Spotify playlist
   poller`), NOT "automated changes". If there is nothing to commit, you made no changes — do
   NOT open a PR or relabel; either use `ask_human` or leave the issue as-is and end your turn.
   ```sh
   git config user.name  "sortie-bot-55"
   git config user.email "297784052+sortie-bot-55@users.noreply.github.com"
   git add -A
   git commit -m "<concise conventional-commit summary of your change>"
   ```

3. **Push** the branch (proxy passed inline — an exported `*_proxy` is not honored for git here):
   ```sh
   git -c http.proxy=$PX push -u origin "$BRANCH"
   ```

4. **Open the PR** with a **clear, specific, descriptive title** that says WHAT the change
   does, in the repo's conventional-commit style — e.g. `feat(music-tracker): add Spotify
   playlist poller` or `fix(web): persist theme toggle across reloads`. **Do NOT use a
   generic "sortie: resolve #N"** — the issue link comes from `Closes #N` in the body, so the
   title is free to be informative. Put every assumption under an `## Assumptions` header.
   ```sh
   TITLE="<concise conventional-commit summary of your change, e.g. feat(scope): add X>"
   HTTPS_PROXY=$PX HTTP_PROXY=$PX gh pr create \
     --repo scolacur/personal-dashboard --base main --head "$BRANCH" \
     --title "$TITLE" \
     --body "$(printf 'Closes #%s\n\nAutomated by Sortie for #%s.\n\n## Assumptions\n- <list yours, or "none">\n' "{{ .issue.identifier }}" "{{ .issue.identifier }}")" || true
   ```
   (On a follow-up the PR already exists, so `gh pr create` no-ops via `|| true` and keeps the
   original title. If the change's scope shifted, update it: `gh pr edit "$BRANCH" --repo scolacur/personal-dashboard --title "$TITLE"`.)

5. **Write `.sortie/scm.json`** — the `reactions` (review-feedback / CI-failure) features
   read this to locate your PR. Resolve the PR number for the branch (works whether you just
   created it or it pre-existed):
   ```sh
   PR_NUMBER="$(HTTPS_PROXY=$PX HTTP_PROXY=$PX gh pr view "$BRANCH" --repo scolacur/personal-dashboard --json number --jq .number)"
   SHA="$(git rev-parse HEAD)"
   mkdir -p "$SORTIE_WORKSPACE/.sortie"
   printf '{"pr_number":%s,"owner":"scolacur","repo":"personal-dashboard","branch":"%s","sha":"%s"}\n' \
     "$PR_NUMBER" "$BRANCH" "$SHA" > "$SORTIE_WORKSPACE/.sortie/scm.json"
   ```

6. **Relabel to `sortie:in-review` — LAST, only after steps 1–5 succeeded.** `sortie:in-review`
   is NOT an active state, so Sortie's reconciler may cancel your worker the instant you
   apply it. That is fine *because everything durable is already done* — but only if this is
   genuinely your final action. Apply it, then end your turn immediately. Do nothing after.
   ```sh
   gh issue edit {{ .issue.identifier }} --repo scolacur/personal-dashboard \
     --remove-label "sortie:in-progress" --add-label "sortie:in-review"
   ```

Then signal completion (`needs-human-review`) and end your turn.
