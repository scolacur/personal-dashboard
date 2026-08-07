# D-025: Prod self-seeds an empty board on boot (opt-in via `SEED_ON_BOOT`); dev is visually marked

**Decision:** On boot, the agent-dashboard widget runs `seedIfEmpty(db)`: if `SEED_ON_BOOT=1`
**and** `agent_tickets` is empty, it imports the committed baseline from `tickets.seed.json`. It's
gated (env flag) and guarded (empty-only + idempotent `seedTickets`), so it never fires in dev and can
never clobber a populated board. `SEED_ON_BOOT=1` is set in the **prod** `.env` (documented in
`.env.example`); dev leaves it unset. Separately, the web layout shows an amber **DEV** badge/stripe
whenever `import.meta.env.DEV` is true (i.e. under `vite dev`, never in the production build), and the
local dev DB was reset to obviously-labeled `[DEV]` dummy tickets.

**Reasoning:**

- The first prod deploy of the board came up empty because the 246 tickets only ever lived in the dev
  DB — data never syncs (the `data/` volume is gitignored and never in the image; only *code* and
  *schema migrations* propagate). We restored prod manually once; `seedIfEmpty` makes a fresh/wiped
  prod volume **self-heal to the baseline** instead of repeating that scramble.
- Opt-in + empty-only is the safety envelope: dev never auto-seeds (would fight the dummy data), and
  prod only seeds a genuinely empty table — a populated board is untouched even if the flag is on.
- The seed JSON is `import`ed (not read from disk) so esbuild inlines it into the server bundle — no
  asset to ship beside the binary, consistent with [[D-024]]. `seedTickets` is shared with the CLI
  importer (`seed/import.ts`), so there's one idempotent code path.
- The **DEV badge** addresses the root cause of "which environment am I editing?" — dev and prod are
  otherwise identical UIs. `import.meta.env.DEV` needs no env wiring and is compile-time guaranteed
  off in prod. Dummy dev data reinforces it (content itself reads `[DEV] … not prod`).

**Implications:**

- To arm prod: `SEED_ON_BOOT=1` must be in the NAS `.env` (gitignored/manual). Without it, an empty
  prod stays empty on boot — the deliberate tradeoff. It's dormant now (board has 246), firing only if
  the table is ever empty.
- Verified: empty+flag seeds 246; reboot+flag no-ops; empty without flag does nothing; full `verify`
  green.

**Revisit if:** we want prod seeding to be unconditional (drop the flag) or to re-sync from an updated
`tickets.seed.json` (would need a smarter merge than empty-only).
