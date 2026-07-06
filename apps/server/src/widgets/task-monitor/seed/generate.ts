/**
 * One-time seed generator: parses the repo's TODO.md files (+ core's META-TODOS.md)
 * into structured tickets and writes tickets.seed.json.
 *
 * Run from the repo root:  npx tsx apps/server/src/widgets/task-monitor/seed/generate.ts
 *
 * This is a local dev tool (reads source files that get archived afterward). The
 * committed tickets.seed.json is the durable artifact; import.ts replays it into any DB.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

type Status = 'backlog' | 'completed';
type Priority = 'low' | 'medium' | 'high';

interface SeedTicket {
  project: string; // slug
  title: string;
  body: string | null;
  priority: Priority;
  status: Status;
  source: string;
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../..'); // .../personal-dashboard
const CORE_META = '/Users/steve/Documents/Dev/core/META-TODOS.md';

// ── helpers ─────────────────────────────────────────────
const DONE_MARKERS = /✅|✓\s*done|~~/i;
// Deliberate priority signals only (not the bare word "high" in prose).
const HIGH_MARKERS = /🔴|HIGH\s*[—–-]|priority:\s*(near-term|high)/i;

function clean(text: string): string {
  return text
    .replace(/~~/g, '')
    .replace(/\*\*/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[✓✔]/g, '')
    .replace(/️/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function priorityOf(s: string): Priority {
  return HIGH_MARKERS.test(s) ? 'high' : 'medium';
}

// Domain prefix from an H1 like "# TODO — Pomodoro Timer Widget" → "[Pomodoro Timer Widget]".
function domainPrefixFromH1(h1: string): string {
  const m = h1.replace(/^#\s*/, '').match(/TODO\s*[—–-]\s*(.+)$/);
  const domain = m ? m[1].trim() : h1.replace(/^#\s*/, '').trim();
  return `[${domain}]`;
}

// Root TODO.md: prefix by section.
function rootPrefix(section: string): string {
  const s = section.toLowerCase();
  if (s.includes('sortie') || s.includes('shipped')) return '[Sortie]';
  if (s.includes('infra')) return '[Infra]';
  if (s.includes('future')) return '[Infra]';
  return '[Dashboard]';
}

interface Block {
  heading: string;
  level: number; // 2 or 3; 0 = pre-heading
  shipped: boolean;
  lines: string[];
}

// Split a file's lines into blocks by ## / ### headings.
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block = { heading: '', level: 0, shipped: false, lines: [] };
  let shippedH2 = false; // core: once under "## SHIPPED", stay shipped until next H2
  for (const line of lines) {
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) {
      blocks.push(cur);
      const level = h[1].length;
      const heading = h[2].trim();
      if (level === 2) shippedH2 = /shipped/i.test(heading);
      const shipped = shippedH2 || /shipped/i.test(heading);
      cur = { heading, level, shipped, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  blocks.push(cur);
  return blocks;
}

// Is this a nav index list (root "## Pages"/"## Widgets" — only markdown links)?
function isIndexList(block: Block): boolean {
  const content = block.lines.filter((l) => l.trim());
  return content.length > 0 && content.every((l) => /^\s*[-*]\s*\[.+\]\(.+\)\s*$/.test(l));
}

// Emit tickets from a block. If it has bold-lead items, one ticket per item; else one for the section.
function ticketsFromBlock(
  block: Block,
  prefixFor: (section: string) => string | null,
  project: string,
  source: string,
): SeedTicket[] {
  const out: SeedTicket[] = [];
  // A "bold-lead" line starts (after an optional bullet and decorative markers like
  // ✅ / ~~ / 🔴) with **bold** — that's a ticket. Returns the label, or null.
  const boldLead = (l: string): string | null => {
    const stripped = l
      // strip a leading bullet only when followed by whitespace, so the '*' of '**bold**' survives
      .replace(/^\s*(?:[-*]\s+)?/, '')
      .replace(/^(?:~~|\p{Extended_Pictographic}|\u{FE0F}|[✓✔~]|\s)+/u, '');
    const m = stripped.match(/^\*\*(.+?)\*\*/);
    return m ? m[1] : null;
  };
  const boldIdx: number[] = [];
  block.lines.forEach((l, i) => {
    if (boldLead(l) !== null) boldIdx.push(i);
  });

  const mkPrefix = (title: string) => {
    const p = prefixFor(block.heading);
    return p ? `${p} ${title}` : title;
  };

  if (boldIdx.length > 0) {
    // One ticket per bold-lead item.
    for (let k = 0; k < boldIdx.length; k++) {
      const start = boldIdx[k];
      const end = k + 1 < boldIdx.length ? boldIdx[k + 1] : block.lines.length;
      const chunk = block.lines.slice(start, end);
      const first = chunk[0];
      const label = boldLead(first) ?? first;
      const title = clean(label).slice(0, 140);
      if (!title) continue;
      const rest = chunk.slice(1).join('\n').trim();
      const bodyLead = first.replace(/^.*?\*\*.+?\*\*[:\s—–~]*/, '').trim();
      const body = [bodyLead, rest].filter(Boolean).join('\n').trim() || null;
      const status: Status = block.shipped || DONE_MARKERS.test(first) ? 'completed' : 'backlog';
      out.push({
        project,
        title: mkPrefix(title),
        body,
        priority: priorityOf(`${first}\n${rest}`),
        status,
        source,
      });
    }
  } else if (block.heading && block.lines.some((l) => l.trim())) {
    // Whole-section ticket. Skip pure container headings (e.g. core's "## SHIPPED").
    if (/^shipped$/i.test(block.heading.trim())) return out;
    const title = clean(block.heading).slice(0, 140);
    if (!title) return out;
    const body = block.lines.join('\n').trim() || null;
    const status: Status = block.shipped || DONE_MARKERS.test(block.heading) ? 'completed' : 'backlog';
    out.push({
      project,
      title: mkPrefix(title),
      body,
      priority: priorityOf(`${block.heading}\n${body ?? ''}`),
      status,
      source,
    });
  }
  return out;
}

function parseFile(
  absPath: string,
  project: string,
  source: string,
  mode: 'domain' | 'root' | 'core',
): SeedTicket[] {
  const raw = readFileSync(absPath, 'utf8');
  const lines = raw.split('\n');
  const h1 = lines.find((l) => /^#\s+/.test(l)) ?? '';
  const blocks = toBlocks(lines);

  const prefixFor = (section: string): string | null => {
    if (mode === 'domain') return domainPrefixFromH1(h1);
    if (mode === 'root') return rootPrefix(section);
    return null; // core: no bracket prefix
  };

  const out: SeedTicket[] = [];
  for (const block of blocks) {
    if (isIndexList(block)) continue;
    // Skip a bare H1-only pre-block with no content.
    out.push(...ticketsFromBlock(block, prefixFor, project, source));
  }
  return out;
}

// ── collect sources ─────────────────────────────────────
const tickets: SeedTicket[] = [];

// personal-dashboard: root, shell, pages/*, widgets/*
const pdFiles: { rel: string; mode: 'domain' | 'root' }[] = [{ rel: 'TODO.md', mode: 'root' }];
if (existsSync(path.join(REPO_ROOT, 'shell/TODO.md')))
  pdFiles.push({ rel: 'shell/TODO.md', mode: 'domain' });
for (const dir of ['pages', 'widgets']) {
  const base = path.join(REPO_ROOT, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const rel = `${dir}/${name}/TODO.md`;
    if (existsSync(path.join(REPO_ROOT, rel))) pdFiles.push({ rel, mode: 'domain' });
  }
}
for (const f of pdFiles) {
  tickets.push(
    ...parseFile(path.join(REPO_ROOT, f.rel), 'personal-dashboard', `seed:${f.rel}`, f.mode),
  );
}

// core: META-TODOS.md
if (existsSync(CORE_META)) {
  tickets.push(...parseFile(CORE_META, 'core', 'seed:core/META-TODOS.md', 'core'));
}

// Deferred-feature follow-ups from this build's schema work — the UIs/behaviors we
// reserved schema for but didn't build yet. Not in any TODO.md; added here so they
// land on the board as trackable tickets.
const FOLLOWUPS: Omit<SeedTicket, 'source'>[] = [
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Ticket relations UI (blocked-by / blocking)',
    body: 'Overflow menu → "Mark as" → "Blocked by…" / "Blocking…"; search modal that filters tickets as you type; blocker/blocked badges on cards. Schema exists: agent_ticket_relations (blocks/relates/duplicates).',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Tags UI (assign / create / filter)',
    body: 'Assign, create, and recolor tags on a ticket; filter the board by tag. Schema exists: agent_tags + agent_ticket_tags (seeded UI, Infra).',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Reminders — UI + delivery job',
    body: 'Add/remove reminders on a ticket (remind_at + note); a scheduled job sends when due (ties into Discord / inbox notifications). Schema exists: agent_ticket_reminders.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Recurring tickets — recur logic',
    body: 'On completing a ticket with recur_interval set (e.g. weekly maintenance), spawn the next occurrence. Schema exists: agent_tickets.recur_interval.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Assignee UI',
    body: 'Set/clear a ticket assignee (human or agent, e.g. "sortie"); filter by assignee. Schema exists: agent_tickets.assignee.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Drag-and-drop reordering within a lane',
    body: 'Reorder tickets within a column via drag-and-drop, writing a fractional sort_order between neighbours. Schema already supports it (sort_order REAL); today moves append.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Activity Feed',
    body: 'Chronological feed of ticket events (created / status_changed / archived / converted). Schema exists: agent_ticket_events (populated from day one).',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Archived view + restore',
    body: 'View soft-deleted (archived) tickets and restore them. Schema exists: agent_tickets.archived_at; delete already soft-deletes.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Phase 3 — Convert ticket to Sortie issue',
    body: 'Per-ticket "Convert to Sortie issue": Claude API formats the ticket into the Sortie issue format (goal/acceptance-criteria/scope) → draft-then-approve → creates a sortie:queued GitHub issue in the project\'s repo → links issue back to the ticket. Needs ANTHROPIC_API_KEY + write-scoped GH token on the NAS. Only for sortie_enabled projects.',
    priority: 'high',
    status: 'backlog',
  },
  {
    project: 'personal-dashboard',
    title: '[Task Monitor] Derived status sync from GitHub labels',
    body: 'node-cron job polls GitHub for each converted ticket\'s sortie:* label + PR merge-state and writes in_progress / in_review / completed onto the row (the derived columns). Avoids coupling to Sortie\'s internal :7678 API.',
    priority: 'medium',
    status: 'backlog',
  },
  {
    project: 'core',
    title: 'Fetch Core TODOs from the dashboard ticket API instead of META-TODOS.md',
    body: "META-TODOS.md stays canonical/Markdown for now (it's load-bearing — referenced across core's README/PROJECT/DECISIONS/MEMORY, and PROJECT.md §42 mandates Markdown). But core's tickets now also live in the dashboard board. Migrate core's references (session-start, /project-maintenance, /project-status) to read Core's tickets from the Task Monitor ticket API (GET /api/widgets/task-monitor/tickets filtered to project=core) so there's one source of truth. Requires the dashboard API reachable from core sessions + a sync/authoring path back. Ties into the META-TODOS 'memory-library'/'replicate Core dev tooling' items.",
    priority: 'high',
    status: 'backlog',
  },
];
for (const f of FOLLOWUPS) {
  tickets.push({ ...f, source: 'seed:task-monitor/followups' });
}

// ── write ────────────────────────────────────────────────
const outPath = path.join(__dirname, 'tickets.seed.json');
writeFileSync(outPath, JSON.stringify(tickets, null, 2) + '\n');

const byProject = tickets.reduce<Record<string, number>>((a, t) => {
  a[t.project] = (a[t.project] ?? 0) + 1;
  return a;
}, {});
const completed = tickets.filter((t) => t.status === 'completed').length;
const high = tickets.filter((t) => t.priority === 'high').length;
console.log(`Wrote ${tickets.length} tickets → ${path.relative(REPO_ROOT, outPath)}`);
console.log(`  by project: ${JSON.stringify(byProject)}`);
console.log(`  completed: ${completed}, high-priority: ${high}`);
