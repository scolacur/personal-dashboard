# D-022: Widget-only logic lives with its widget, not in `packages/shared`; `apps/web` has its own test runner

**Decision:** `packages/shared` is reserved for code that genuinely crosses the client/server
boundary — the request/response *types* the server serves and the web fetches (e.g. `AgentTicket`,
`CreateTicketInput`). Pure logic used by **only one side** now lives with its consumer. Concretely,
the Pomodoro timer logic (`formatTime`, `advancePhase`, `clampRoundsBeforeLongBreak` + its types)
moved from `packages/shared/src/pomodoro.ts` to
`apps/web/src/routes/widgets/pomodoro/timer-logic.ts`, next to `PomodoroTimer.svelte`, and `apps/web`
gained its own vitest setup (`vitest` devDep + `test` script + an isolated `vitest.config.ts` with no
SvelteKit plugin). This supersedes the pomodoro half of [[D-018]] and closes [[D-017]]'s open
follow-up ("shared logic tested indirectly from `apps/server/src`").

**Reasoning:**

- `pomodoro.ts` was never actually shared. Its only runtime consumer was the web component; the only
  other importer was a *test file* in `apps/server`. It lived in `shared` purely so the server's
  vitest could reach it — because `apps/web` had no test runner. That is a testing-infrastructure gap
  leaking into architecture (the tail wagging the dog): a single-purpose, web-only module was placed
  in a cross-cutting package for test access, not because anything on the server used it.
- The honest fix is to give `apps/web` a test runner and keep widget logic with its widget. Colocated
  logic is easier to find, and it shrinks the "rebuild `shared` after every edit" gotcha ([[D-019]]) —
  widget logic changes far more often than the shared wire types do, so keeping it out of `shared`
  means fewer forced `shared` rebuilds mid-dev.
- The rule going forward: **shared = types/values on the wire between server and web. Everything else
  lives with its consumer.** If two *runtime* consumers ever need the same logic, promote it to
  `shared` (or a future `apps/server/src/lib/`) then — not preemptively.

**Implications:**

- `apps/web` now runs `vitest run` (16 Pomodoro tests moved over); root `npm run test` runs both the
  server and web suites, so `npm run verify` covers both.
- **Both workspaces are pinned to the same vitest, `^4.1.9`** (was `^3.2.6`). This matters because of
  a Vite-version skew: `vitest@3.2.6` peers on Vite ≤7, but `apps/web` is on Vite 8, so under 3.2.6
  npm nested a second Vite (7.x) under `vitest`, and `svelte-check` errored on the two copies'
  conflicting global `ImportMeta` augmentation. `vitest@4.1.9` peers `^6 || ^7 || ^8`, so it dedupes
  to the single Vite 8 already installed — no nested copy, no type conflict, and specs are type-checked
  by `svelte-check` normally (no tsconfig `exclude` workaround needed). Keep the two workspaces on the
  same vitest major to avoid reintroducing a duplicate Vite.

**Revisit if:** a piece of widget logic genuinely gains a second runtime consumer on the other side of
the wire — promote it to `packages/shared` at that point.
