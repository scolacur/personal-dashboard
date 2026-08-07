# D-023: `packages/shared` emits Node-resolvable ESM (NodeNext + explicit `.js` extensions + `exports` map)

> **Reverted by [[D-024]]:** shared is no longer built or loaded by Node at runtime (the server is
> esbuild-bundled and inlines shared source), so the NodeNext + `.js`-extension packaging this
> decision added is no longer needed. Kept for the record — the root-cause analysis of *why* extensionless
> ESM breaks Node's native loader still stands and is exactly why D-024's bundle-everything approach is safe.

**Decision:** `packages/shared` is compiled with `"module": "NodeNext"` / `"moduleResolution":
"NodeNext"` (was `ESNext` / `Bundler`), its source uses **explicit `.js` extensions** on relative
imports (`export … from './agent-dashboard.js'`), and its `package.json` declares an `exports` map
(`"." → { types, default }`) alongside `main`/`types`. It stays a single **ESM** package (browser
consumption still requires ESM — see [[D-019]]). The CommonJS server (`tsc` → `node dist/index.js`)
loads it via Node's stable `require(ESM)` (Node ≥20.19; the runtime image is `node:20-slim`).

**Reasoning:**

- **This is what broke prod** (MODULE_NOT_FOUND on deploy). Under `moduleResolution: Bundler`, tsc
  emitted **extensionless** re-exports (`export … from './agent-dashboard'`). Bundlers (Vite for web,
  vitest, esbuild) resolve those fine, so dev/CI were green — but **Node's native ESM loader requires
  file extensions**, so the moment the server imported `@dashboard/shared` at runtime it threw
  `ERR_MODULE_NOT_FOUND` on the internal `./agent-dashboard` import. This is exactly the dev/prod
  divergence [[D-019]] flagged, now biting from the runtime side.
- **Why it only broke recently:** [[D-019]] noted "the server imports `@dashboard/shared` only in a
  `.spec.ts`, never at runtime." That stopped being true when the agent-dashboard widget shipped —
  `routes.ts` imports the *values* `TICKET_STATUSES`/`TICKET_PRIORITIES` (not just types), which emits
  a real `require('@dashboard/shared')`. First prod boot with that widget → crash. (`store.ts` uses
  `import type` only, so it's erased and doesn't count.)
- **NodeNext + `.js` extensions is the standards-compliant fix.** The emitted `./agent-dashboard.js`
  resolves under Node's ESM loader, and every bundler consumer (Vite/vitest/svelte-check) handles
  explicit extensions transparently — so it's correct everywhere, no divergence. The `exports` map is
  packaging hygiene (modern resolvers use it; `main` remains for older ones).
- **Not the web adapter.** The reported symptom looked like a "dist vs build" problem, but `apps/web`
  already does the right thing: `@sveltejs/adapter-static` writes to `apps/web/build/` (gitignored,
  built in the Dockerfile, served by Fastify). The break was entirely in the shared package's module
  format, not the web output directory.

**Implications:**

- Verified by **booting the built server** (`node apps/server/dist/index.js`) against a temp data dir
  and hitting `/api/health` — the real prod path, not just a bundler build. CI/`verify` builds but
  never boots the server, which is precisely why this class of bug shipped ([[D-019]]'s open revisit
  note). **Recommended guard:** a smoke test that boots the compiled server and curls `/api/health`,
  wired into the Dockerfile build stage or CI, so a runtime-load regression fails the build.
- Depends on Node ≥20.19 (`require(ESM)`); the runtime is pinned to `node:20-slim`. If that ever
  regresses below 20.19, either dual-build `shared` (CJS+ESM via an `exports` `require`/`import` split)
  or convert the server to ESM.

**Revisit if:** the server moves to ESM (then it imports `shared` natively, no `require(ESM)`), or Node
drops below 20.19 in the image (dual-build `shared`).
