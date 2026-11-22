import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No source file may import a CLI entry point (2026-11-21 crash loop).
 *
 * Each extra esbuild entry point (`build.mjs`) runs its CLI behind `require.main === module`. When
 * the worker imports one, esbuild inlines it into `dist/index.js`, where that guard is TRUE, so the
 * CLI runs at boot. `index.ts` imported `deploy-drain.ts` for one helper; every worker start ran the
 * drain and exited 0, and `restart: unless-stopped` turned that into a crash loop. Shared logic
 * belongs in a library module (`deploy-hold.ts`) that both import.
 */

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function cliEntryModules(): string[] {
  const build = readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');
  const block = build.slice(build.indexOf('entryPoints:'), build.indexOf('outdir:'));
  return [...block.matchAll(/'(src\/[^']+)\.ts'/g)]
    .map((m) => path.join(ROOT, m[1]))
    .filter((p) => p !== path.join(SRC, 'index'));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [full] : [];
  });
}

describe('esbuild CLI entry points', () => {
  it('finds the CLI entries in build.mjs', () => {
    const entries = cliEntryModules().map((p) => path.relative(SRC, p));
    expect(entries).toContain('deploy-drain');
    expect(entries).toContain(path.join('jobs', 'visual', 'capture-cli'));
  });

  it('are never imported by another source file', () => {
    const entries = new Set(cliEntryModules());
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/from\s+'(\.[^']+)'|require\(\s*'(\.[^']+)'\s*\)|import\(\s*'(\.[^']+)'\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3];
        const target = path.resolve(path.dirname(file), spec).replace(/\.(ts|js)$/, '');
        if (entries.has(target)) offenders.push(`${path.relative(SRC, file)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
