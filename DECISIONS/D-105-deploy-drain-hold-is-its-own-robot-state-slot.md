# D-105: The deploy-drain hold is its own `robot_state` slot, not a reason on the maintenance hold (PD-802)

> **Amended by [[D-116]]:** exit 75 is the ONLY code that stops a Watchtower update. Any other
> non-zero code is logged and the recreate proceeds, so the drain now fails closed (every error exits 75).

**Decision:** the deploy drain (`apps/agent-worker/src/deploy-drain.ts`) holds dispatch through a
**dedicated `robot_state` key** — `deploy_hold`, with its own `takeDeployHold` /
`releaseDeployHold` / `activeDeployHold` in `apps/agent-worker/src/jobs/robot/state.ts` — rather than
reusing the maintenance hold's slot with a distinguishing `reason`. The Robot dispatch gate reads it
as a fourth, independent hold alongside the system-wide pause, the session-limit hold and the
maintenance hold. The new container releases a lingering deploy hold on boot
(`releaseDeployHoldOnStartup`, called from `index.ts`).

**Reasoning:**

- **The ticket offered both, and the codebase already settled the general case.** `state.ts` spells
  out at length why the maintenance hold is a separate slot and not a third `kind` on the
  session-limit hold: `robot_state` holds are single last-writer-wins slots, and two conditions with
  **independent causes and independent lifetimes** that share one slot break in both directions,
  silently. A deploy and a human's maintenance window are exactly two such conditions, so the same
  rule applies.
- **Sharing the maintenance slot reintroduces the documented clobber, both ways.** A deploy drain
  running mid-maintenance-window would overwrite the maintenance hold's reason and deadline; the
  coordinator never re-takes it, so dispatch would resume while a maintenance job is still editing
  files. Worse in reverse: the new container's release-on-boot would null "the hold", clearing a
  maintenance window a human had opened — dispatch resumes straight into the window it was meant to
  protect. A `reason` tag does not prevent either: it only lets a reader *notice* after the fact.
- **A separate slot makes release-on-boot safe by construction.** With its own key, the boot release
  clears only the deploy slot (D-077's one-owner-per-slot rule), so it can never touch a maintenance
  or session-limit hold no matter what else is in force.
- **The deadline is a bound, not a schedule.** The drain takes the hold with
  `until = now + stallThresholdMs` — the same ~2h bound a stalled run gets — so a drain process that
  dies between taking the hold and the recreate completing cannot wedge dispatch shut forever.
  `activeDeployHold` self-clears a lapsed hold on read, exactly like the maintenance and
  session-limit holds, and the new container's boot release is the ordinary path.
- **Exit 75 is Watchtower's retry signal.** The pre-update lifecycle hook treats `EX_TEMPFAIL` (75)
  as "cancel this update and retry on the next poll" without logging an error; any other non-zero
  code cancels but is noisier, and 0 lets the recreate proceed. The hold is taken on both paths so
  nothing new dispatches even while the hook is retrying.

**Implications:** the Robot dispatch gate grows a fourth hold check (`robot.ts`), and `index.ts`
calls `releaseDeployHoldOnStartup` after opening the DB. `deploy-drain.ts` is a third esbuild entry
point (`dist/deploy-drain.js`) beside `index.js` and `capture-cli.js`. No schema change — the hold is
one more key in the existing `robot_state` table.

**Revisit if:** the deploy hold ever needs to coexist with a *second* kind of deploy (e.g. a
blue/green swap that holds for a different reason), which would be the same "two slots" argument one
level down; or if Watchtower's hook contract changes the meaning of exit 75.
