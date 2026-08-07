# D-024: `@dashboard/shared` is consumed from source (no build, no `dist`); the server is esbuild-bundled

**Decision:** `packages/shared` is no longer built to `dist/` and consumed as a compiled package.
It's a **source-only** package (`main`/`types`/`exports` all point at `./src/index.ts`, no `build`
script) and every consumer resolves its **source**:

- **Web** (`apps/web`): `svelte.config.js` `kit.alias` maps `@dashboard/shared` → `../../packages/shared/src/index.ts`, which wires both Vite and the generated tsconfig. Vite bundles the source in dev *and* prod.
- **Server** (`apps/server`): built with **esbuild** (`apps/server/build.mjs`) into a single CJS bundle. `packages: 'external'` keeps all npm deps out of the bundle (crucially `better-sqlite3`'s native `.node` binary), and an esbuild `alias` rewrites `@dashboard/shared` to its source so it's the one dependency inlined.
- **Server dev/typecheck** (`tsx`, `tsc --noEmit`): resolve shared via its `package.json` `types`/`exports` → `src/index.ts`.

This **supersedes [[D-019]]** (there is no `dist` to rebuild, so the rebuild-after-edit gotcha is gone)
and **reverts [[D-023]]** (NodeNext + explicit `.js` extensions were only needed for Node to load the
built `dist/` at runtime — which no longer happens; shared is back to extensionless imports +
`moduleResolution: Bundler` for its own typecheck).

**Reasoning:**

- Modeled on Splice's `surfaces/apps/web-svelte`, which has **no `dist` for internal libs** — it resolves them from source via `tsconfig.base.json` paths wired into Vite/svelte-kit. Bundlers inline the source; nothing is handed to Node's native loader as a pre-built package. That architecture simply doesn't have the class of bug we kept hitting.
- Both of our `dist`-era bugs came from the gap between *bundler* resolution (lenient) and *Node's native ESM loader* (strict): D-019's stale-`dist` browser crash and D-023's extensionless-import `ERR_MODULE_NOT_FOUND`. Consuming source through bundlers everywhere (Vite, esbuild, tsx) closes that gap — the strict Node loader is never in the path for shared.
- D-019 rejected a dev-only src alias to preserve dev/prod parity. That objection is now moot: the alias is **unconditional** (dev and prod both bundle source), so there's no divergence — the exact thing D-019 wanted, achieved the other way.

**Implications:**

- **Verified end-to-end:** full `verify` green (shared typecheck, web `svelte-check`, server `tsc`, lint, 52 + 16 tests); the **esbuild server bundle boots** (`/api/health` ok) with `packages/shared/dist` deleted and `better-sqlite3` loading natively; `tsx` dev and `vite dev`/build both resolve source.
- **Dockerfile simplified:** no `shared` build step, no `shared/dist` copy. The server bundle is self-contained except for external npm deps (still shipped via the pruned `node_modules`).
- **Tradeoff / dependency:** shared is now only consumable by a **bundler-or-transpiler** (Vite, esbuild, tsx, vitest) — never by plain `node` against a bare `@dashboard/shared` import. If some future entry point needs to `node`-run code that imports shared without bundling, either bundle it too or reintroduce a build. `better-sqlite3` (and any native dep) must stay in esbuild's `external` set.

**Revisit if:** we add a Node entry point that imports shared without going through esbuild/tsx (then bundle it or give shared a build again).
