import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { scanText, skipPath, type SecretFinding } from './secret-scan';

/**
 * `npm run secrets:scan` (PD-767): scan every tracked file AND every untracked, non-ignored file in
 * the repo for credential-shaped strings. Untracked files matter most: a Robot runs `npm run verify`
 * before it commits, so a token in a brand-new file is caught before it is ever pushed. Exits 1 on
 * any finding, which fails `npm run verify` and so the Robot's hand-off and CI's required check.
 */

const MAX_BYTES = 2 * 1024 * 1024;

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function listFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))];
}

function main(): void {
  const root = repoRoot();
  const findings: SecretFinding[] = [];
  let scanned = 0;
  for (const rel of listFiles(root)) {
    if (skipPath(rel)) continue;
    const abs = path.join(root, rel);
    let size = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_BYTES) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) continue; // binary
    scanned++;
    findings.push(...scanText(rel, text));
  }
  if (findings.length === 0) {
    console.log(`secret-scan: ${scanned} files, no secrets found.`);
    return;
  }
  console.error(`secret-scan: ${findings.length} possible secret(s) found. Remove them, and rotate any that were real:`);
  for (const f of findings) console.error(`  ${f.path}:${f.line}  ${f.label}  ${f.masked}`);
  console.error(`A false positive can be silenced with "secret-scan: allow" on the same line.`);
  process.exit(1);
}

main();
