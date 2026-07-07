import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Extract a top-level Markdown section by its `## ` heading prefix, up to the next
 * `## ` (or EOF). Used to pull the glossary (PROJECT.md §8) into the grill prompt
 * without dragging the whole file along. Returns '' if not found.
 */
export function extractSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Build the compact, STABLE project-context prefix for the grill system prompt (D-044).
 *
 * Deliberately small + deterministic so it prompt-caches: the PROJECT.md glossary
 * (§8) plus an index of what already exists (server widgets, web widget routes,
 * shared modules) so the agent knows what to reuse before proposing new work. It is
 * NOT a codebase dump — deep lookups happen on-demand via the agent's read-only
 * repo tools (Read/Grep/Glob) scoped to the checkout.
 */
export function buildContextPack(checkoutDir: string): string {
  const parts: string[] = [];

  const projectMd = path.join(checkoutDir, 'PROJECT.md');
  if (existsSync(projectMd)) {
    const glossary = extractSection(readFileSync(projectMd, 'utf8'), '## 8. Glossary');
    if (glossary) parts.push(glossary);
  }

  const serverWidgets = listDir(path.join(checkoutDir, 'apps/server/src/widgets'));
  const webWidgets = listDir(path.join(checkoutDir, 'apps/web/src/routes/widgets'));
  const sharedModules = existsSync(path.join(checkoutDir, 'packages/shared/src'))
    ? readdirSync(path.join(checkoutDir, 'packages/shared/src'))
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .sort()
    : [];

  parts.push(
    [
      '## Existing building blocks (reuse before adding new)',
      serverWidgets.length ? `- Server widgets: ${serverWidgets.join(', ')}` : '',
      webWidgets.length ? `- Web widget routes: ${webWidgets.join(', ')}` : '',
      sharedModules.length ? `- Shared modules (packages/shared/src): ${sharedModules.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return parts.join('\n\n').trim();
}
