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
await build({
  entryPoints: [path.resolve(__dirname, 'src/index.ts')],
  outfile: path.resolve(__dirname, 'dist/index.js'),
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
