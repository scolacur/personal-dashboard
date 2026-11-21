import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundle the agent-worker worker into a single CJS file, mirroring apps/server/build.mjs:
//
//  - `packages: 'external'` keeps every npm dependency out of the bundle — most
//    importantly `better-sqlite3` (native .node binary) and the Claude Agent SDK,
//    which ships its own runtime. The runtime image still installs node_modules.
//  - The alias inlines `@dashboard/shared` from SOURCE (no dist) — DECISIONS D-024.
// PD-773: the screenshot step runs as its own process (dropped to the Robot's uid), so it is its
// own entry point: dist/capture-cli.js beside dist/index.js.
// PD-802 (D-105): the Watchtower pre-update drain is also its own process — the hook runs
// dist/deploy-drain.js before recreating the container.
await build({
  entryPoints: {
    index: path.resolve(__dirname, 'src/index.ts'),
    'capture-cli': path.resolve(__dirname, 'src/jobs/visual/capture-cli.ts'),
    'deploy-drain': path.resolve(__dirname, 'src/deploy-drain.ts'),
  },
  outdir: path.resolve(__dirname, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  packages: 'external',
  alias: {
    '@dashboard/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
  },
  sourcemap: true,
  logLevel: 'info',
});
