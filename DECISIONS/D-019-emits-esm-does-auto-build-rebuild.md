# D-019: `packages/shared` emits ESM; `dev` does not auto-build it (rebuild-after-edit is manual)

> **Superseded by [[D-024]]:** `shared` is no longer built to `dist/` at all — it's consumed from
> source by every bundler/transpiler (Vite, esbuild, tsx). There is nothing to rebuild after editing,
> so this decision's central "rebuild-after-edit is manual" gotcha no longer exists. (Historical note:
> the `moduleResolution: Bundler` + extensionless imports below is what [[D-023]] later had to work
> around for Node runtime loading — a problem D-024 removes by never loading shared through Node.)

**Decision:** `packages/shared` is an **ESM** package — `"type": "module"` in its `package.json` and `"module": "ESNext"` / `"moduleResolution": "Bundler"` in its `tsconfig.json` (was `"module": "CommonJS"`). Separately, we deliberately do **not** wire a shared build/watch into `npm run dev`: after editing `packages/shared/src`, you must rebuild it (`npm run build -w packages/shared`, or just `npm run verify`, which builds first) before the web dev server reflects the change.

**Reasoning:**

- **The CommonJS output crashed the browser.** The web app (`apps/web`, Svelte/Vite) imports `@dashboard/shared` at runtime (the Pomodoro widget — see [[D-018]]). With CommonJS output, `dist/index.js` was `Object.defineProperty(exports, …)`; Vite's dev server serves modules to the browser as native ESM, where `exports` is undefined → **"exports is not defined"**. ESM output (`export …`) is consumable by both the browser (web) and Node/vitest (server).
- **Switching to ESM is safe for the server.** `apps/server` imports `@dashboard/shared` only in a `.spec.ts` (vitest, which handles ESM natively) — never at runtime — so the server's CommonJS build/run path is unaffected. `moduleResolution: Bundler` lets the extensionless `./pomodoro` import emit as-is; Vite and vitest both resolve it.
- **Why CI didn't catch the bug.** `npm run verify` builds → typechecks → lints → unit-tests, but never boots the dev server or loads a page in a browser. The failure was *dev-mode-only*: `vite build` (prod) bundles via Rollup, whose commonjs plugin transparently converts CJS→ESM, so the production build was green even with CJS output. CI also always builds `shared` from source, so the *stale-`dist/`* half of the problem (local `dist/` predating the Pomodoro code) can't occur in CI either.
- **Why not auto-build shared in `dev`.** Considered three options (a `predev` build-once, a `tsc --watch` process in `concurrently`, and aliasing Vite to `shared/src`). Chose none. `shared` is small and edited infrequently (types + a few pure functions); the pain is real but rare and almost always the "stale `dist/` at startup" case. A `predev` build-once would create a false sense of liveness (mid-session edits still go stale); `tsc --watch` HMR through the symlinked workspace dep is finicky and adds a process; aliasing to `src` would make dev resolve source while prod resolves `dist` — re-hiding exactly the dev/prod divergence that produced this bug. Keeping the manual build preserves dev↔prod parity (both consume `dist/`) and the local signal that comes with it.

**Implications:** The "rebuild `shared` after editing" step is a known manual gotcha, not an oversight. Builds on [[D-017]]'s open follow-up (`packages/shared` still has no vitest config of its own; shared logic is tested indirectly from `apps/server/src`).

**Revisit if:** `shared` starts being edited frequently while `dev` is running and the manual rebuild becomes a recurring annoyance — then add `tsc --watch` (plus a `predev` build-once to cover cold starts), or give CI a dev-mode smoke test (load `/`, assert no console errors) to catch this class of bug.
