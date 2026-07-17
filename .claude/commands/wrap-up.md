# /wrap-up

Session wrap-up for Personal Dashboard.

## Instructions

### Step 1 — Run global wrap-up

Read and follow the full instructions in `~/.claude/commands/wrap-up.md`, using this project context:
- Project path: `/Users/steve/Documents/Dev/Projects/personal-dashboard`
- Memory target: `/Users/steve/Documents/Dev/Projects/personal-dashboard/MEMORY/`

### Step 2 — Curate memory from merged Robot PRs

Robot runs never write to MEMORY/ (concurrent merges would conflict on the daily
file). Instead, each run's durable record lives in its PR (title, `Closes #N`,
`## Assumptions` block, and any `DECISIONS.md` entry). This step folds the non-obvious
parts of recently-merged Robot work into a single curated memory entry.

1. Determine the boundary: the date of the most recent `MEMORY/YYYY-MM-DD.md` file.
2. List Robot PRs merged since then:
   ```sh
   gh pr list --repo scolacur/personal-dashboard --state merged \
     --search "merged:>=<boundary-date>" \
     --json number,title,mergedAt,headRefName,labels,body \
     --jq '.[] | select(.headRefName | startswith("robot/"))'
   ```
3. Skim each body — what shipped, the `## Assumptions`, and any decision it logged.
4. Fold anything **non-obvious** (a surprising design choice, an assumption worth
   revisiting, a gotcha that bit the agent) into today's `MEMORY/YYYY-MM-DD.md` under a
   `## Robot merges` subsection — ONE entry, written by you, not per-PR. Skip routine
   merges that the PR/commit history already explains on its own. Update `MEMORY/MEMORY.md`
   with the usual one-line pointer.

This is the only path by which agent work reaches MEMORY — agents capture in PRs, Tank
curates here.

### Step 3 — Project-specific steps

[Add more project-specific wrap-up steps here as the project grows.]
