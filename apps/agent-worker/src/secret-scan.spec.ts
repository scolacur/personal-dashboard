import { describe, it, expect } from 'vitest';
import { ALLOW_MARKER, mask, scanText, skipPath } from './secret-scan';

// Fake tokens are assembled at runtime so this file never contains a literal the scan would flag.
const rep = (c: string, n: number) => c.repeat(n);
const GH = 'gh' + 'p_' + rep('A1', 18);
const FINE = 'github' + '_pat_' + rep('b2', 35);
const ANT = 'sk-' + 'ant-api03-' + rep('Xy', 30);
const OR = 'sk-' + 'or-v1-' + rep('ab', 32);
const AWS = 'AK' + 'IA' + rep('Q', 16);
const KEY = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';

describe('secret-scan (PD-767)', () => {
  it('finds each credential shape, with path and line', () => {
    const text = ['ok', `const t = "${GH}";`, `token: ${FINE}`, ANT, `OPENROUTER=${OR}`, AWS, KEY].join('\n');
    const ids = scanText('x.ts', text).map((f) => `${f.line}:${f.patternId}`);
    expect(ids).toEqual(['2:github-pat-classic', '3:github-pat-fine', '4:anthropic', '5:openrouter', '6:aws-access-key', '7:private-key']);
  });

  it('never returns the secret itself, only a masked preview', () => {
    const [f] = scanText('x.ts', GH);
    expect(f.masked).not.toContain(GH);
    expect(f.masked).toBe(`${GH.slice(0, 4)}…${GH.slice(-2)} (${GH.length} chars)`);
    expect(mask('short')).toBe('****');
  });

  it('ignores short placeholders that only share a prefix', () => {
    expect(scanText('x.ts', 'GH_TOKEN=ghp_write sk-ant-xxx github_pat_statuses_only AKIA123')).toEqual([]);
  });

  it(`skips a line carrying "${ALLOW_MARKER}"`, () => {
    expect(scanText('x.ts', `${GH} // ${ALLOW_MARKER}`)).toEqual([]);
  });

  it('skips generated, vendored and binary paths', () => {
    expect(skipPath('node_modules/x/index.js')).toBe(true);
    expect(skipPath('apps/web/.svelte-kit/output/a.js')).toBe(true);
    expect(skipPath('package-lock.json')).toBe(true);
    expect(skipPath('data/dashboard.db')).toBe(true);
    expect(skipPath('apps/server/src/index.ts')).toBe(false);
  });
});
