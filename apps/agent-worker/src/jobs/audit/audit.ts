import type Database from 'better-sqlite3';
import type { AuditRunCounts } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import {
  finishRun,
  firstProjectWithActiveTickets,
  getAuditableTickets,
  insertFinding,
  type AuditableTicket,
  type ClaimedRun,
} from './audit-db';
import { runAuditTurn } from './audit-agent';

// Recommendation buckets the audit agent may emit (D-045). 'keep' = no action needed;
// it's recorded so a re-run can show the ticket was reviewed and deliberately left alone.
const FINDING_TYPES = ['archive', 'complete', 'reprioritize', 'update', 'keep'] as const;

/** A finding as the agent emits it (before we resolve the ticket + persist). */
interface RawFinding {
  ticketId?: number;
  displayId?: string;
  type?: string;
  recommendation?: string;
  reason?: string;
  evidence?: string;
  proposedChange?: string;
}

/** Injectable seams so the pass is unit-testable without a live agent or a real checkout. */
export interface AuditPassDeps {
  runAgent?: (config: AgentWorkerConfig, systemPrompt: string, prompt: string) => Promise<{ text: string; ok: boolean }>;
  buildContext?: (checkoutDir: string) => string;
}

const AUDIT_SYSTEM_PROMPT = [
  'You are the Ticket Audit agent for a personal-dashboard task board (D-045).',
  'You review a project\'s active tickets and flag which are stale, done, mis-prioritized,',
  'or need a description update — grounding every finding in evidence from the repo checkout',
  '(MEMORY/, DECISIONS.md, PROJECT.md, and the code) rather than speculation.',
  '',
  'You are READ-ONLY: you never modify tickets or the repo. You only report findings; a human',
  'decides what to apply.',
  '',
  'Return ONLY a JSON array (no prose) of findings, each:',
  '  { "displayId": "PD-142", "type": "archive|complete|reprioritize|update|keep",',
  '    "recommendation": "<short imperative>", "reason": "<why>", "evidence": "<cited source>" }',
  'Include a finding only when you have concrete evidence. Omit tickets you cannot assess.',
  '',
  'Project context:',
].join('\n');

function ticketsPrompt(projectName: string, tickets: AuditableTicket[]): string {
  const lines = tickets.map(
    (t) => `- ${t.displayId ?? `#${t.id}`} [${t.status}/${t.priority}] ${t.title}\n    ${(t.body ?? '').slice(0, 500).replace(/\n/g, ' ')}`,
  );
  return [
    `Audit these ${tickets.length} active tickets in project "${projectName}". Cross-reference`,
    'the checkout to decide each one, then return the JSON findings array.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Parse the agent's reply into raw findings. Tolerant: pulls the last JSON array out of the
 * text (handles a bare array or one fenced in ```json). Returns [] on anything unparseable.
 */
export function parseAuditFindings(text: string): RawFinding[] {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  if (!candidate || candidate.indexOf('[') === -1) return [];
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? (parsed as RawFinding[]) : [];
  } catch {
    return [];
  }
}

/**
 * Run one audit pass over a SINGLE project (the tracer bullet — fan-out is PD-284). Picks the
 * lowest-id project with active tickets, asks the agent to bucket each, persists the findings,
 * and closes the run with counts. Advisory only — never mutates a ticket (D-045 guardrail).
 */
export async function runAuditPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  run: ClaimedRun,
  deps: AuditPassDeps = {},
): Promise<AuditRunCounts> {
  const runAgent = deps.runAgent ?? runAuditTurn;
  const buildContext = deps.buildContext ?? buildContextPack;

  const project = firstProjectWithActiveTickets(db);
  if (!project) {
    const counts: AuditRunCounts = { projects: 0, tickets: 0, findings: 0 };
    finishRun(db, run.id, 'done', { counts, model: config.model });
    logger.info({ runId: run.id }, 'audit: no project with active tickets — nothing to do');
    return counts;
  }

  const tickets = getAuditableTickets(db, project.id);
  const byDisplayId = new Map(tickets.filter((t) => t.displayId).map((t) => [t.displayId as string, t.id]));
  const validIds = new Set(tickets.map((t) => t.id));

  const systemPrompt = `${AUDIT_SYSTEM_PROMPT}\n${buildContext(config.checkoutDir)}`;
  const reply = await runAgent(config, systemPrompt, ticketsPrompt(project.name, tickets));
  if (!reply.ok) {
    // API/billing/rate error — surface it as an errored run so it's retried, don't persist junk.
    throw new Error(`audit agent turn failed: ${reply.text.slice(0, 200)}`);
  }

  const raw = parseAuditFindings(reply.text);
  const buckets: Record<string, number> = {};
  let persisted = 0;
  for (const f of raw) {
    // Resolve the ticket the finding is about; drop findings we can't tie to an audited ticket.
    const ticketId =
      typeof f.ticketId === 'number' && validIds.has(f.ticketId)
        ? f.ticketId
        : f.displayId && byDisplayId.has(f.displayId)
          ? (byDisplayId.get(f.displayId) as number)
          : null;
    if (ticketId === null) continue;
    const type = (FINDING_TYPES as readonly string[]).includes(f.type ?? '') ? (f.type as string) : 'update';
    insertFinding(db, {
      runId: run.id,
      projectId: project.id,
      ticketId,
      type,
      recommendation: f.recommendation ?? null,
      reason: f.reason ?? null,
      evidence: f.evidence ?? null,
    });
    buckets[type] = (buckets[type] ?? 0) + 1;
    persisted += 1;
  }

  const counts: AuditRunCounts = { projects: 1, tickets: tickets.length, findings: persisted, ...buckets };
  finishRun(db, run.id, 'done', { counts, model: config.model });
  logger.info({ runId: run.id, project: project.key, ...counts }, 'audit: run complete');
  return counts;
}
