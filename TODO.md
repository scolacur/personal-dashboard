# TODO Index

- [Dashboard Shell](Shell/TODO.md)

## Pages

- [Agent Dashboard (Mission Control)](pages/agent-dashboard/TODO.md)

## Widgets

- [Music Tracker](widgets/music-tracker/TODO.md)


## Sortie Integration

**📌 Give `packages/shared` its own vitest setup** (flagged 2026-06-30). Shared logic currently gets tested *indirectly* from `apps/server/src` (the #26 agent's workaround, since `packages/shared` has no test runner and the root `verify` only runs server tests). Adding vitest to `shared` needs a devDependency — out of scope for unattended bots, so it needs a human/explicit issue. Until then shared logic lives untested-in-place.

**Test the egress work** Also, see if this means that the bots can't do research or read docs, and whether this is an issue. Maybe need some sort of way for it to ask permission to view a certain domain, via the ask_human command when we build that. And I can 1-time or permanently allowlist stuff. Basically re-creating the permissions check from Claude code but moving it to Discord (or wherever that communication happens) in a way that I get notified so that I don't block.

**Token exposure reduction**

**ask_human functionality** — ⚠️ BUILT + on `main` (2026-06-30), live-verification deferred. `sortie-ask-human.yml` (owner reply on `sortie:awaiting-human` → re-queue) + WORKFLOW.md ask/resume protocol + `sortie:awaiting-human` label all shipped. Still TODO: (a) verify the round-trip with a real Sortie run (agent can `gh` mid-turn, self-relabel survives the reconciler, re-queue resumes vs restarts); (b) Discord webhook forwarding. The max_sessions silent-park gap below is now covered by the watchdog (capped issue → `sortie:stuck` + @mention).
- NOTE (2026-06-29): when `agent.max_sessions` is exhausted, Sortie **stops dispatching but does NOT move the issue to a failed state or notify me** — it silently parks (still labeled, just never re-dispatched). Token-burn is bounded, but a stuck issue is invisible until I happen to look. **Determine the right behavior:** likely (a) transition the issue to a `sortie:failed` terminal label so it's visibly dead and drops out of candidates, AND (b) ping me on exhaustion (Discord/`ask_human`). Sortie has no auto-transition on exhaustion, so this needs a mechanism — an `after_run`/hook check on `SORTIE_ATTEMPT` vs the cap, or Sortie's `notifications` config. Ties into Discord + retry-cap items.

**Discord Integration** - both for `ask_human` but also as a way for me to submit issues

**Mission Control / host access to the Sortie API (:7678)** Under the egress-hardened setup Sortie is on an `internal: true` network, so its port can't be published to the host (confirmed: no host route for internal networks). For now use `docker exec sortie curl localhost:7678/...`. When building Mission Control, run it as a container on the `egress_internal` network so it reaches `sortie:7678` container-to-container (no host port, isolation intact). Only add a forwarder sidecar (socat/nginx on both networks) if something off-NAS genuinely needs the API.

**Ensure bots write tests** Most likely needs to be done via the Issue Generation Template

**Ensure bots actually use the harness** Instruct them to run the `/core-session-start` command on start and the `/wrap-up` command on end. If needed, create special variants of these skills that are meant to be used only by bots operating in a swarm. For example, the "1 memory entry per day" paradigm doesn't work great if bots are continuously merging and deploying, since only the first one of the day would get added.

**GUI for Issue Generation** Do after we have Discord set up. The process won't feel complete until I can use the dashboard's GUI itself to submit issues. Possible that the easiest thing is that writing out my issue in Github actually just sends a Discord message on my behalf, after we have discord set up. That way the Dashboard itself may not need to have any knowledge of / access to agents. It just posts a message, that message gets picked up by Sortie.

**Brain-dump → ticket skill/template** Turn stream-of-consciousness feature requests into proper goal/acceptance-criteria/scope issues fast. Reuse `to-issues`/`to-prd`/`triage` skills or a GitHub issue template. Overlaps "GUI for Issue Generation" and "Ensure bots write tests via template".

**PR change-request follow-up** — ✅ RESOLVED 2026-06-30 (see Shipped). The `reactions.review_comments` block dispatches a continuation, and the prompt now reliably detects the follow-up (STEP 0 / D-017) and fetches the review body. Verified on #26/PR #27 (summary review → agent edited the function + test).

**File-access allowlist** (structural control) Bound what the agent may read/write beyond the container isolation already in place. Deferred CORE-harness control; also tracked in CORE META-TODOS.

### Shipped 2026-06-30
- ✅ **Review-fix continuation fixed + VERIFIED** (`3fa4c2e`; D-017). Replaced the dead `{{ if .run.is_continuation }}` gate (false for review-reaction dispatches) with an unconditional **STEP 0** that detects an existing PR and fetches the feedback explicitly (`gh api .../reviews` for the summary body + inline comments + own prior diff), then edits rather than appends. Verified on #26/PR #27: summary review → `/reviews` fetched, agent edited the single function + its test, no duplication.
- ✅ **Tests required for feature work** (`3fa4c2e`) — agent writes vitest tests for new/changed logic and self-checks its diff (continuations too). (`packages/shared` test-runner gap tracked above.)
- ✅ **Descriptive PR titles + commit messages** (`d3010a4`) — conventional-commit style, no more `sortie: resolve #N`; safety-net derives its title from the commit subject.
- ✅ **P1 hand-off fix MERGED + VERIFIED end-to-end** (PR #19; D-016). Agent does push/PR/scm.json/relabel in-turn (relabel last); `after_run`→safety-net; `before_run` regenerates scm.json; watchdog `rescue-labels` job. Proven on #22/PR #23: agent did it in-turn (item 1), clean `handoff transition succeeded` no `context canceled` (item 2), review-fix continuation works (item 3).
- ✅ **3rd exit-128 cause fixed** (`a247b9b`) — Sortie runs `after_create` with CWD=`$SORTIE_WORKSPACE`; the `rm -rf` deleted the shell's own cwd → `git clone` failed at getcwd(). Fix: `cd /home/sortie` before the rm.
- ✅ **Agent `npm ci` before verify** (`ed1ca4d`) — fresh clone had no node_modules so the in-turn verify hit `tsc: not found`; agents were shipping unverified. (npm registry already allowlisted.)
- ✅ **Workspaces made ephemeral** (`e9b2102`) — `workspace.root`→container-local `/tmp/sortie-workspaces`, dropped the NAS bind-mount; deploys start clean, no stale clones on the NAS. (Resolves the "why persist the workspace?" design question — the `rm -rf` stays for within-run re-dispatch.)
- ✅ **Exit-128 stuck-loop root-caused + fixed** — three causes: (1) `after_create` didn't wipe the persistent per-issue workspace → `git clone` into a non-empty dir = exit 128 (`669d36b`); (2) hooks ran under a stripped env where `export …_proxy` didn't reach git/gh on the egress-internal network → pass proxy inline per command (`3f07151`); (3) single-file bind-mount inode trap meant `git pull` didn't update the in-container hook until `--force-recreate` (the `sortie-refresh` alias). #6 and #8 both ran clean afterward.
- ✅ **`verify` enforced as a required status check on `main`** (`contexts:["verify"]`, `strict:false`; Sortie Step-2 protection preserved — check ADDED, not replaced).
- ✅ **CI/CD follow-ups** — library-mount-path runbook prep, GHA action version bumps (no more Node 20 deprecation warnings).
- ✅ **Sortie watchdog (Layer 1)** — `sortie-watchdog.yml`: `queued`>20m / `in-progress`>120m → `sortie:stuck` + @mention; surfaces all 3 silent-park modes (prep-loop, max_sessions cap, restart-orphan).
- 🔬 **#6 → PR #17 (merged: reusable Widget + 3D flip)**; **#8 → PR #18 (open, `sortie:in-review`: Pomodoro)** — full pipeline proven end-to-end. PR #18 awaiting Steve's review.

### Shipped 2026-06-29
- ✅ **Sortie deployed to the NAS** (Container Manager, egress-hardened compose) — full loop proven end-to-end (PR #4).
- ✅ **Egress allowlist** (squid sidecar + internal Docker network) — token exfil structurally contained; verified (direct egress BLOCKED, GitHub 200, arbitrary host 403). `.datadoghq.com` allowlisted.
- ✅ **query_filter authorization gate** — repo is public, so only issues a collaborator has labeled get run.
- ✅ **handoff_state (`sortie:in-review`) + "Closes #N"** — fixes the infinite-re-run / duplicate-PR bug (a merged/successful issue stayed "active", got re-dispatched → dup PR #5 + burned quota). Successful run now exits the active set; merge auto-closes the issue.


## Infra

**Retry cap / max-attempts** — ⚠️ PARTIALLY ADDRESSED (2026-06-30). The ~43× storm's root causes (exit-128 prep-retry loop) are fixed, and capped/parked issues are now made *visible* by `sortie-watchdog` (`sortie:stuck` + @mention) instead of silently grinding. Still open if wanted: a true per-issue max-attempts ceiling (Sortie's `max_sessions:3` caps agent sessions but not workspace-prep retries).

**Pro usage-limit handling** The retry storm exhausted the Claude Pro quota → instant `turn_failed`. Monitor usage and/or add an API-key fallback or guard (ties into RAM/CPU limits below).

**RAM & CPU Monitor / usage limits** - The NAS is not that powerful of a machine. Ensure the operation doesn't grow boundlessly and impact other processes of the machine. May need to set limits on the container or image/process itself from within Synology.

## Future Improvements

**Abstract out any infra and design decisions that can be abstracted for easy integration into future projects & websites** This includes the Sortie integration, CI/CD pipeline, model integration, Memory System

