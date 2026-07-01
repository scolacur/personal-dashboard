import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundle the server into a single CJS file. Two deliberate choices:
//
//  - `packages: 'external'` keeps every npm dependency out of the bundle — most
//    importantly `better-sqlite3`, whose compiled `.node` binary can't be
//    bundled. The runtime image still ships node_modules for these.
//  - The alias rewrites `@dashboard/shared` to its SOURCE before the external
//    check runs, so it's the one thing that DOES get inlined. That's how we
//    consume shared from source (no dist) without a workspace package at
//    runtime — see DECISIONS D-024.
//
// CJS (not ESM) so `__dirname` — used to locate apps/web/build — resolves
// natively without an import.meta shim.
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
