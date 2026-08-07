# D-047: Sortie sensitive-path guardrails are two-tier — an authoritative, runtime-independent CI path-guard (Tier 1) plus a runtime-coupled in-loop Claude Code layer (Tier 2), both fed by one shared denylist (PD-308, PD-312; supersedes C-2, PD-13, C-15)

> ⚠️ **STATUS 2026-08-04: TIER 1 LIVE, TIER 2 STILL OPEN.** PD-308 shipped
> `.github/sensitive-paths.txt` + `.github/workflows/path-guard.yml`, and `path-guard` is now a
> **required status check** on `main`. The guard runs base-ref via `pull_request_target` and
> matches with git's own `:(glob)` pathspecs. **PD-312 (Tier 2) remains unshipped** — no Claude
> Code `permissions.deny`, no PreToolUse hook.
>
> The design below stands as written. Two implementation notes worth carrying:
>
> - **Wiring is a separate step from landing the workflow.** A required check that has never
>   reported blocks every PR, so the guard was proven on throwaway PRs in *both* directions
>   (#280 red→green-on-label, #281 green) before being added to protection.
> - **`enforce_admins` stays false**, so an admin can still `--admin` merge past a red guard. That
>   is the trust model working as designed: the guard binds the unsupervised Robot (whose
>   auto-merge honours required checks via `mergeStateStatus == CLEAN`), and the human is the ack.

**Decision:** Bounding what an autonomous Sortie worker may change **inside the repo** is enforced in **two tiers**, split by whether the layer survives an agent-runtime swap:

- **Tier 1 — authoritative, runtime-independent (PD-308).** A CI **path-guard** at the git/GitHub boundary: a required GitHub Actions check that goes red when a PR's diff touches any path in a shared denylist (`.github/sensitive-paths.txt`), **unless** a write+ collaborator applies a `sensitive-change-approved` label. It runs **base-ref** (`pull_request_target`) so a PR cannot weaken the guard or the list within the same PR. Because it inspects the **diff, not the agent**, it holds regardless of which runtime produced the commit. Branch protection already covers *direct-to-main* runtime-independently; `--no-verify` is moot (CI re-runs `verify`); `push --force` only ever touches the agent's own `sortie/<id>` branch.
- **Tier 2 — in-loop, runtime-coupled (PD-312).** Claude Code `permissions.deny` (generated from the same denylist) + a PreToolUse hook that degrades a block into an **`ask_human` park** (PD-241) rather than a hard fail. Provisioned in **managed settings baked into the container image** (`/etc/claude-code/managed-settings.json`, root-owned; the agent runs non-root, uid 1001) so the agent cannot edit its own guardrail. Its job is early feedback + UX, **not** the boundary — on a runtime swap it evaporates and must be re-implemented for the new runtime; Tier 1 keeps protecting meanwhile.
- **One shared denylist.** `.github/sensitive-paths.txt` is the single source of truth both tiers consume (the CI guard reads it; the Claude Code deny rules are generated from it). This is the useful residue of C-2's "policy artifact" idea — runtime-independent, maintained once. Self-protecting: `.github/**` and `ops/sortie/**` are in the list, so the agent can't quietly widen its own allowance.
- **Scope.** In-repo sensitive-path + dangerous-command protection only. "Writes **outside** the sandbox" are already contained by container isolation (no path to `/core`) + the squid egress allowlist (PD-30) and are explicitly out of scope — which is why C-2's original "processes touching files outside `/core`" framing does not map to the real residual risk here.

**Why:** Today the only structural controls are container isolation + squid egress; every "don't touch secrets/auth/CI/schema/deps" rule is **prompt-only** (`ops/sortie/WORKFLOW.md`), which is untrustworthy for an unsupervised agent. #192 (2026-07-07) was a live near-miss — the agent tried to edit `.github/workflows/sortie-watchdog.yml` and **only a missing token scope** stopped it, an accident rather than a designed guardrail. Putting the authoritative layer at the git boundary answers the portability question directly: a future Claude Code → Qwen/Ollama runtime swap must not silently disable protection, and a diff-inspecting check is agent-agnostic. The runtime-native layer is kept only as swappable early feedback.

**Trade-off:** Two layers + a shared list is more moving parts than simply configuring Claude Code permissions (the single-tier option) — accepted because single-tier is **silently** runtime-coupled and evaporates on a swap with no warning. A deliberately broad denylist means legitimate sensitive changes (e.g. #192's watchdog edit) go red and need an explicit human ack label — accepted; that friction **is** the control.

**Trade-off (grill provenance):** Combined + refined from C-2/PD-13/C-15 in a 2026-07-07 grill session. The reframe from C-2's "outside `/core`" to "in-repo sensitive paths" was the pivotal move; the two-tier split fell out of the "what if we switch off Claude Code?" question.

**Implications:** Combines + **supersedes C-2, PD-13, C-15** (closed, folded into PD-308). Split into **PD-308** (Tier 1, P1) + **PD-312** (Tier 2, P2). New repo artifacts: `.github/sensitive-paths.txt`, a base-ref path-guard workflow, the `sensitive-change-approved` label, a branch-protection required check; later the managed-settings + PreToolUse hook in the Sortie image. The denylist is drawn against the current NAS/Docker-on-Synology layout — **PD-311** (P1, Mac Mini Migration epic PD-188) re-evaluates it post-migration. PD-241 (`ask_human` park/resume, verified) is the degrade path Tier 2 falls back to. Glossary terms (*sensitive path*, *path-guard*, *guardrail tier*, *`sensitive-change-approved`*) added to PROJECT.md §8.
