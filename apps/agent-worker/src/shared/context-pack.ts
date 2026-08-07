import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Extract a top-level Markdown section by its `## ` heading prefix, up to the next
 * `## ` (or EOF). Returns '' if not found.
 *
 * Prefer {@link extractSectionMatching} for anything read out of a document people edit —
 * a heading prefix pins the section *number*, and section numbers move. See PD-496.
 */
export function extractSection(markdown: string, headingPrefix: string): string {
  return sliceSection(markdown.split('\n'), (l) => l.startsWith(headingPrefix));
}

/**
 * Extract a top-level Markdown section by matching its `## ` heading against a pattern.
 *
 * This exists because the prefix form was pinned to a section number and silently lost its
 * section when the document was renumbered (PD-496): `PROJECT.md`'s glossary became §9 in #185,
 * `buildContextPack` was written against `'## 8. Glossary'` in #195 — *after* — and every Refine
 * and Audit run since has shipped with no glossary at all. Nothing failed; the pack was just
 * quietly smaller.
 *
 * Match on the words in the heading, never on its ordinal.
 */
export function extractSectionMatching(markdown: string, pattern: RegExp): string {
  return sliceSection(markdown.split('\n'), (l) => l.startsWith('## ') && pattern.test(l));
}

/** Shared body: from the first matching line to the next `## ` heading (or EOF). */
function sliceSection(lines: string[], matches: (line: string) => boolean): string {
  const start = lines.findIndex(matches);
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

/** Matches `## 9. Glossary / Domain Language`, `## Glossary`, `## 12. Glossary of terms`, … */
export const GLOSSARY_HEADING = /\bglossary\b/i;

function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Build the compact, STABLE project-context prefix for the refine and audit system prompts (D-044).
 *
 * Deliberately small + deterministic so it prompt-caches: the PROJECT.md glossary plus an index of
 * what already exists (server widgets, web widget routes, shared modules) so the agent knows what
 * to reuse before proposing new work. It is NOT a codebase dump — deep lookups happen on-demand
 * via the agent's read-only repo tools (Read/Grep/Glob) scoped to the checkout.
 *
 * `onMissing` is called for any expected section that could not be found. The pack is still
 * returned — a missing glossary degrades an agent, it does not justify failing the run — but it is
 * never silent again: PD-496 was invisible for two months precisely because an empty section was
 * indistinguishable from an absent one.
 */
export function buildContextPack(checkoutDir: string, onMissing: (what: string) => void = () => {}): string {
  const parts: string[] = [];

  const projectMd = path.join(checkoutDir, 'PROJECT.md');
  if (!existsSync(projectMd)) {
    onMissing(`PROJECT.md not found at ${projectMd}`);
  } else {
    // Matched on the word "Glossary", never on its section number — see extractSectionMatching.
    const glossary = extractSectionMatching(readFileSync(projectMd, 'utf8'), GLOSSARY_HEADING);
    if (glossary) parts.push(glossary);
    else onMissing(`no "## … Glossary …" heading in ${projectMd}`);
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
