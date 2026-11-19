/**
 * Deterministic secret scan (PD-767). Pure: finds credential-shaped strings in text. The CLI
 * (`secret-scan-cli.ts`, run by `npm run verify`) feeds it every tracked and untracked file, so a
 * Robot cannot hand off — and CI cannot go green — with a token in the tree.
 *
 * Patterns are deliberately specific (a known prefix AND a realistic length) rather than a generic
 * entropy check: a scan that cries wolf on test fixtures gets an allow-comment sprinkled everywhere
 * and stops meaning anything. A genuine false positive is silenced with `secret-scan: allow` on the
 * same line.
 *
 * Findings never carry the secret itself — only a masked preview — so the scan's own output (CI
 * logs, a Robot transcript) cannot become the leak.
 */

export interface SecretPattern {
  id: string;
  /** What to rotate if it fires. */
  label: string;
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'github-pat-classic', label: 'GitHub personal access token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-pat-fine', label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { id: 'anthropic', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{40,}/g },
  { id: 'openrouter', label: 'OpenRouter API key', re: /\bsk-or-v1-[a-f0-9]{48,}\b/g },
  { id: 'openai', label: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}T3BlbkFJ[A-Za-z0-9_-]{10,}/g },
  { id: 'aws-access-key', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g },
];

export const ALLOW_MARKER = 'secret-scan: allow';

export interface SecretFinding {
  path: string;
  line: number;
  patternId: string;
  label: string;
  /** First 4 and last 2 characters only. */
  masked: string;
}

export function mask(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/** Scan one file's text. Lines carrying `secret-scan: allow` are skipped. */
export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    if (lineText.includes(ALLOW_MARKER)) return;
    for (const p of SECRET_PATTERNS) {
      p.re.lastIndex = 0;
      for (const m of lineText.matchAll(p.re)) {
        findings.push({ path, line: i + 1, patternId: p.id, label: p.label, masked: mask(m[0]) });
      }
    }
  });
  return findings;
}

/** Paths never worth scanning: generated, vendored, or binary-by-extension. */
export function skipPath(path: string): boolean {
  return (
    /(^|\/)node_modules\//.test(path) ||
    /(^|\/)(dist|build|\.svelte-kit)\//.test(path) ||
    /package-lock\.json$/.test(path) ||
    /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|mp3|mp4|webm|zip|gz|sqlite|db)$/i.test(path)
  );
}
