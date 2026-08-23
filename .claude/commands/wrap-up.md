# /wrap-up

Session wrap-up for Personal Dashboard.

## Instructions

### Step 1 — Run global wrap-up

Read and follow the full instructions in `~/.claude/commands/wrap-up.md`, using this project context:
- Project path: `/Users/steve/Documents/Dev/Projects/personal-dashboard`
- Memory target: `/Users/steve/Documents/Dev/Projects/personal-dashboard/MEMORY/`

### Step 2 — Curate the Robot memory inbox

A Robot never writes the day file or `MEMORY/MEMORY.md` — those stay human-curated. It writes
**one file per run** to `MEMORY/runs/YYYY-MM-DD-<branch>.md` on its own branch, merged with its
PR (PD-306). One file per run rather than appending to the shared day file, for the same reason
decisions are one file each ([[D-070]]): concurrent writers never touch the same path, so nothing
has to resolve a merge conflict.

`MEMORY/runs/` is an **inbox**. This step empties it.

1. Read everything in `MEMORY/runs/` (ignore `README.md`). Each file names what shipped and a
   **Worth remembering** line.
2. For any run whose file is thin or says "nothing beyond the diff", check the PR itself before
   concluding there was nothing — the `## Assumptions / Flags` and `## Memory / Decisions`
   sections of the envelope carry more:
   ```sh
   gh pr list --repo scolacur/personal-dashboard --state merged \
     --search "merged:>=<date of the most recent MEMORY/YYYY-MM-DD.md>" \
     --json number,title,mergedAt,headRefName,body \
     --jq '.[] | select(.headRefName | startswith("robot/"))'
   ```
3. Fold anything **non-obvious** (a surprising design choice, an assumption worth revisiting, a
   gotcha that cost the agent turns) into today's `MEMORY/YYYY-MM-DD.md` under a `## Robot merges`
   subsection — ONE entry that you write, not one per run. Skip routine work the commit history
   already explains. Update `MEMORY/MEMORY.md` with the usual one-line pointer.
4. **Delete the files you curated** (`git rm MEMORY/runs/<file>.md`). Leaving them means the next
   wrap-up re-reads work already recorded. Files piling up here means wrap-up has not run — the
   content is uncurated, not lost.

This is the only path by which agent work reaches MEMORY — agents capture per-run, Tank curates
here.

### Step 3 — Log any decision this session made

A durable architectural decision goes in its own file in the **decision inbox** —
**`DECISIONS/incoming/D-TMP-<TICKET><letter>.md`**, first line `# D-TMP-<TICKET><letter>: Title`
(D-070, D-078). For a session on PD-513 that is `DECISIONS/incoming/D-TMP-PD513a.md`; use `b`, `c`, …
for a second decision from the same ticket. **That file is the entire change** — do not run
`npm run decisions:index` and do not touch `DECISIONS.md`. It lists numbered decisions only, so
authoring one conflicts with nobody (PD-551). Never hand-edit `DECISIONS.md`; it is generated.

**Do not pick a `D-NNN`, even when you are certain no other session is running.** That certainty is
the hand-check D-078 removes, and it has been wrong here twice. A daily numbering cycle assigns the
number in merge order and rewrites your `D-TMP-` citations.

Then the day-file entry for it is SHORT and links to the decision by its **provisional** id (per the
global wrap-up Step 3) — the decision file is canonical, MEMORY does not re-narrate it. The cycle
rewrites that citation along with the others.

### Step 4 — Project-specific steps

[Add more project-specific wrap-up steps here as the project grows.]
