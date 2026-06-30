# TODO Index

- [Dashboard Shell](Shell/TODO.md)

## Pages

- [Agent Dashboard (Mission Control)](pages/agent-dashboard/TODO.md)

## Widgets

- [Music Tracker](widgets/music-tracker/TODO.md)


## Sortie Integration

**Test the egress work** Also, see if this means that the bots can't do research or read docs, and whether this is an issue. Maybe need some sort of way for it to ask permission to view a certain domain, via the ask_human command when we build that. And I can 1-time or permanently allowlist stuff. Basically re-creating the permissions check from Claude code but moving it to Discord (or wherever that communication happens) in a way that I get notified so that I don't block.

**Token exposure reduction**

**ask_human functionality**
- NOTE (2026-06-29): when `agent.max_sessions` is exhausted, Sortie **stops dispatching but does NOT move the issue to a failed state or notify me** — it silently parks (still labeled, just never re-dispatched). Token-burn is bounded, but a stuck issue is invisible until I happen to look. **Determine the right behavior:** likely (a) transition the issue to a `sortie:failed` terminal label so it's visibly dead and drops out of candidates, AND (b) ping me on exhaustion (Discord/`ask_human`). Sortie has no auto-transition on exhaustion, so this needs a mechanism — an `after_run`/hook check on `SORTIE_ATTEMPT` vs the cap, or Sortie's `notifications` config. Ties into Discord + retry-cap items.

**Discord Integration** - both for `ask_human` but also as a way for me to submit issues

**Mission Control / host access to the Sortie API (:7678)** Under the egress-hardened setup Sortie is on an `internal: true` network, so its port can't be published to the host (confirmed: no host route for internal networks). For now use `docker exec sortie curl localhost:7678/...`. When building Mission Control, run it as a container on the `egress_internal` network so it reaches `sortie:7678` container-to-container (no host port, isolation intact). Only add a forwarder sidecar (socat/nginx on both networks) if something off-NAS genuinely needs the API.

**Ensure bots write tests** Most likely needs to be done via the Issue Generation Template

**Ensure bots actually use the harness** Instruct them to run the `/core-session-start` command on start and the `/wrap-up` command on end. If needed, create special variants of these skills that are meant to be used only by bots operating in a swarm. For example, the "1 memory entry per day" paradigm doesn't work great if bots are continuously merging and deploying, since only the first one of the day would get added.

**GUI for Issue Generation** Do after we have Discord set up. The process won't feel complete until I can use the dashboard's GUI itself to submit issues. Possible that the easiest thing is that writing out my issue in Github actually just sends a Discord message on my behalf, after we have discord set up. That way the Dashboard itself may not need to have any knowledge of / access to agents. It just posts a message, that message gets picked up by Sortie.

**Brain-dump → ticket skill/template** Turn stream-of-consciousness feature requests into proper goal/acceptance-criteria/scope issues fast. Reuse `to-issues`/`to-prd`/`triage` skills or a GitHub issue template. Overlaps "GUI for Issue Generation" and "Ensure bots write tests via template".

**PR change-request follow-up** Sortie should notice when I request changes on a PR and continue editing that same PR (PR-reactions / re-dispatch on review). Tried once; the bot didn't notice. Relates to re-adding the `reactions` block (removed during setup — see `ops/sortie/README.md` follow-ups).

**File-access allowlist** (structural control) Bound what the agent may read/write beyond the container isolation already in place. Deferred CORE-harness control; also tracked in CORE META-TODOS.

### Shipped 2026-06-29
- ✅ **Sortie deployed to the NAS** (Container Manager, egress-hardened compose) — full loop proven end-to-end (PR #4).
- ✅ **Egress allowlist** (squid sidecar + internal Docker network) — token exfil structurally contained; verified (direct egress BLOCKED, GitHub 200, arbitrary host 403). `.datadoghq.com` allowlisted.
- ✅ **query_filter authorization gate** — repo is public, so only issues a collaborator has labeled get run.
- ✅ **handoff_state (`sortie:in-review`) + "Closes #N"** — fixes the infinite-re-run / duplicate-PR bug (a merged/successful issue stayed "active", got re-dispatched → dup PR #5 + burned quota). Successful run now exits the active set; merge auto-closes the issue.


## Infra

**Retry cap / max-attempts** A persistently-failing issue retried ~43× (every 5 min), burning Pro quota. Find/set Sortie's max-attempts so failures stop looping and surface instead of grinding.

**Diagnose #8 (Pomodoro) clone failure** `after_create` git clone exits 128 (looped to attempt 43) — likely a stale workspace dir not cleaned on rollback. Parked; fix before re-queueing.

**Pro usage-limit handling** The retry storm exhausted the Claude Pro quota → instant `turn_failed`. Monitor usage and/or add an API-key fallback or guard (ties into RAM/CPU limits below).


**CI/CD Pipeline** - Don't require me to manually pull from `main` and re-create the container each time there's a code push.

**RAM & CPU Monitor / usage limits** - The NAS is not that powerful of a machine. Ensure the operation doesn't grow boundlessly and impact other processes of the machine. May need to set limits on the container or image/process itself from within Synology.

## Future Improvements

**Abstract out any infra and design decisions that can be abstracted for easy integration into future projects & websites** This includes the Sortie integration, CI/CD pipeline, model integration, Memory System

