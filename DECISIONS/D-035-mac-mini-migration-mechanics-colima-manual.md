# D-035: Mac Mini migration mechanics — Colima, manual cutover, `.local` addressing, auto-login boot, NFS library (resolves [[D-031]]'s open items)

> **Amended 2026-07-17 (post-[[D-055]]):** the second stack this migration moves is no longer the
> third-party **Sortie** runtime — it's the dashboard's own **agent-worker** (the Robot loop + the
> Refine/Audit jobs, `ops/agent-worker/`). Consequences for the mechanics below:
> - **`/data` (and `dashboard.db`) lives on a Colima VM-native volume, not a macOS-host bind mount.**
>   A host mount reaches the container over virtiofs, which presents host ownership and flattens Linux
>   mode/uid semantics — it would silently break the D-055 uid-split (mode-`660` + `robot` uid-`1500`
>   exclusion is what kernel-enforces [[D-039]]: the coding session physically can't read the DB). A
>   VM-native ext4 path keeps that exclusion real, exactly as on the NAS. This is inherent to bridging
>   APFS↔Linux — **no** macOS Docker runtime (Colima/OrbStack/Docker Desktop) can preserve it on a host
>   mount, so the choice is runtime-independent. Trade-off: PD-190's off-box backup shipper must reach
>   *into* the VM for `data/backups/` rather than grab a plain macOS file.
> - **The agent-worker is built on-host** (deliberately NOT on GHCR/Watchtower — [[D-044]]), so the Mini
>   needs the build toolchain, and step 3 must **reproduce the uid-split**: loop runs as root (owns
>   `dashboard.db`), the coding session is dropped to uid `1500`, DB `chmod 660`. There is **no separate
>   `.sortie.db`** (the worker shares the web app's `dashboard.db`) and **no quota-refund cron** (the C2
>   fault-tier replaced Sortie's `max_sessions` economics; `ops/sortie/` was removed in C7).
> - **Disarmed bring-up.** Because the worker is now an *autonomous* coding agent, it comes up with
>   dispatch paused (`ROBOT_ALLOWLIST=NONE` / `ROBOT_DISPATCH_ENABLED=0`) and is **armed only after**
>   egress-jail + uid-split + one refine turn verify on Colima *and* the NAS loop is confirmed stopped —
>   mirrors the C1 prove-on-one discipline and prevents a double-loop against the queue during the
>   rollback window.
> - **Colima is unaffected** — Sortie's retirement touches none of its reasons, and the sudoless
>   per-user `docker` it brings actually *fixes* the NAS's password-gated `sudo docker` pain (why a
>   runaway run couldn't be killed over SSH). Its egress jail (squid `internal:` network) + the uid-split
>   are exactly why a Linux-VM runtime stays mandatory (native macOS would drop both). PD-200's OrbStack
>   re-eval stays on its ~1-month soak, decoupled from the cutover.

**Decision:** The migration mechanics [[D-031]] left "not yet designed" are settled. Lift-and-shift,
so only the host-forced changes:

- **Docker runtime: Colima** (not OrbStack, not Docker Desktop). Headless/launchd-managed, OSS (no
  licensing), explicit VM sizing on the shared 24 GB box (rec. `--cpu 6 --memory 12 --disk 100`).
  Docker Desktop needs a GUI session; OrbStack is commercial + desktop-oriented. **Re-evaluate after
  ~1 month** (P2 ticket; set a 2026-08-01 reminder once the reminders feature lands). Watchtower's
  socket mount changes under Colima (`~/.colima/default/docker.sock`, not `/var/run/docker.sock`) —
  adjust the dashboard compose.
- **Addressing: mDNS `.local` hostname, keep port 8088.** Set a stable name via
  `scutil --set HostName`. One-time sweep of hardcoded `192.168.68.50:8088` (CLAUDE.md,
  `ROBOT_BOARD_URL`, `ops/` runbooks, compose) → `<mini>.local:8088`. (8080 is free without gluetun,
  but keeping 8088 avoids gratuitous reference churn.)
- **Data cutover: manual.** Stop both stacks → `VACUUM INTO` the DB (`dashboard.db`, now shared by
  web + agent-worker — folds the WAL, the D-025 lesson) → transfer NAS→Mini over `ssh cat` (NAS has no
  SFTP subsystem) → land it on the **VM-native `/data` volume** → checksum + verify (health, ticket
  count, `agent_runs` row counts) → **keep the NAS DB frozen as rollback** until the Mini is proven,
  then decommission. agent-worker egress containment re-verified on Colima (direct = blocked,
  proxied = 200 — same Linux Docker engine inside the Lima VM, so it ports as-is; a verify item, not
  a redesign).
- **Reboot recovery: auto-login + a LaunchAgent** that starts Colima → waits for `docker info` →
  brings up the dashboard stack → then the agent-worker egress stack (explicit order), with
  `restart: unless-stopped` as backstop. Colima is per-user, so unattended recovery requires a
  logged-in session → auto-login. **Trade-off accepted:** the box boots to an unlocked session
  (FileVault left off) — acceptable for an always-on LAN home server whose entire purpose is
  unattended uptime.
- **DJ library: NFS mounted directly inside the Colima VM (`:ro`), as a fast-follow** (separate
  ticket), off the critical-path cutover — music-tracker isn't wired to the real library yet.
  NFS-into-the-VM avoids the macOS-host→VM double-hop and SMB quirks; resolves D-031's "SMB/NFS"
  open choice.

**Go private stays a separate later step (P1 ticket):** flipping the repo private breaks the
currently-public GHCR pull — the Mini's pull path then needs a `read:packages` token, or the
lift-and-shift Watchtower pull fails silently.

**Why manual / lift-and-shift throughout:** a one-time personal-LAN cutover — minimize
simultaneously-changing variables and keep the proven pipeline. Re-architecting the deploy model
(local build now that the M4 can build) is deferred, per [[D-031]].
