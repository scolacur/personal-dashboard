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
  api_key: $SORTIE_GITHUB_TOKEN          # bot account's fine-grained PAT
  project: $SORTIE_GITHUB_PROJECT         # scolacur/personal-dashboard
  # Labels MUST be pre-created in the repo — the adapter does not auto-create them.
  # active_states = states a worker should be running for. in_progress_state MUST be
  # included here, or the reconciler cancels the worker the moment the agent flips the
  # issue to in-progress.
  active_states: ["sortie:queued", "sortie:in-progress"]
  in_progress_state: "sortie:in-progress"   # set when the agent starts
  terminal_states: ["sortie:done", "sortie:wontfix"]

polling:
  interval_ms: 30000                       # poll every 30s

workspace:
  root: /home/sortie/workspaces            # per-issue dir created under here; isolated, no path to /core

agent:
  kind: claude-code
  command: claude
  max_turns: 50
  max_concurrent_agents: 1                  # PILOT: one ticket at a time

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

reactions:
  enabled: true                             # PR-reaction feedback loop

hooks:
  # Clone the Dashboard ONLY into the isolated workspace. Token-in-URL because
  # hooks run in a restricted env (only system + SORTIE_* vars; SORTIE_GITHUB_TOKEN
  # is available). No SSH keys, no path to /core.
  after_create: |
    git clone "https://x-access-token:${SORTIE_GITHUB_TOKEN}@github.com/scolacur/personal-dashboard.git" "$SORTIE_WORKSPACE"

  # Fresh branch off main for each attempt.
  before_run: |
    cd "$SORTIE_WORKSPACE"
    git fetch origin main
    git checkout -B "sortie/${SORTIE_ISSUE_IDENTIFIER}" origin/main

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
    PR_BODY=$(printf 'Automated by Sortie for #%s. Self-review: %s.\n\n%s' "$SORTIE_ISSUE_IDENTIFIER" "$SORTIE_SELF_REVIEW_STATUS" "$REVIEW_NOTE")
    gh pr create \
      --repo scolacur/personal-dashboard \
      --base main \
      --head "sortie/${SORTIE_ISSUE_IDENTIFIER}" \
      --title "sortie: resolve #${SORTIE_ISSUE_IDENTIFIER}" \
      --body "$PR_BODY"

db_path: /home/sortie/.sortie.db
---

# Working on #{{ .issue.identifier }}: {{ .issue.title }}

{{ .issue.description }}

---

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
