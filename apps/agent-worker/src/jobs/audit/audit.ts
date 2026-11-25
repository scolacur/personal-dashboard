import type Database from 'better-sqlite3';
import { auditSystemPrompt, type AuditRunCounts } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import {
  auditableProjects,
  finishRun,
  getAuditableTickets,
  insertFinding,
  projectByKey,
  recordAuditRunUsage,
  updateAuditRunProgress,
  type AuditableTicket,
  type AuditProject,
  type ClaimedRun,
} from './audit-db';
import { runAuditTurn, type AuditProgress } from './audit-agent';

// Recommendation buckets the audit agent may emit (D-045). 'keep' = no action needed;
// it's recorded so a re-run can show the ticket was reviewed and deliberately left alone.
const FINDING_TYPES = ['archive', 'complete', 'reprioritize', 'update', 'keep'] as const;

/** How sure the agent is about a finding (PD-284). Anything off this list is dropped to null. */
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

/** A finding as the agent emits it (before we resolve the ticket + persist). */
interface RawFinding {
  ticketId?: number;
  displayId?: string;
  type?: string;
  recommendation?: string;
  reason?: string;
  evidence?: string;
  proposedChange?: string;
  confidence?: string;
}

/** Injectable seams so the pass is unit-testable without a live agent or a real checkout. */
export interface AuditPassDeps {
  runAgent?: (
    config: AgentWorkerConfig,
    systemPrompt: string,
    prompt: string,
    onProgress?: AuditProgress,
  ) => Promise<{ text: string; ok: boolean; turns?: number; tokens?: number }>;
  buildContext?: (checkoutDir: string, onMissing?: (what: string) => void) => string;
}

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

/** Read a `single:<KEY>` scope, returning the project KEY it targets, or null for a full sweep. */
export function singleScopeKey(scope: string | null): string | null {
  if (!scope) return null;
  const m = scope.match(/^single:(.+)$/);
  return m ? m[1].trim() : null;
}

/** The outcome of auditing one project: its findings persisted, plus the usage its turn spent. */
interface ProjectPassResult {
  tickets: number;
  findings: number;
  buckets: Record<string, number>;
  turns?: number;
  tokens?: number;
}

/**
 * Audit ONE project: ask the agent to bucket its active tickets, then persist the findings
 * (with confidence, PD-284). Returns the per-project tallies. Throws on an agent error so the
 * caller's try/catch treats the project as failed-and-skipped (Done-When #3) — it never aborts
 * the whole run. Advisory only — never mutates a ticket (D-045 guardrail).
 *
 * `turnsBase` / `tokensBase` are the run's usage BEFORE this project, so live progress reports a
 * running total across the fan-out rather than resetting per project.
 */
async function auditOneProject(
  db: Database.Database,
  config: AgentWorkerConfig,
  run: ClaimedRun,
  project: AuditProject,
  systemPrompt: string,
  runAgent: NonNullable<AuditPassDeps['runAgent']>,
  turnsBase: number,
  tokensBase: number,
): Promise<ProjectPassResult> {
  const tickets = getAuditableTickets(db, project.id);
  const byDisplayId = new Map(tickets.filter((t) => t.displayId).map((t) => [t.displayId as string, t.id]));
  const validIds = new Set(tickets.map((t) => t.id));

  const reply = await runAgent(config, systemPrompt, ticketsPrompt(project.name, tickets), (t, k) =>
    updateAuditRunProgress(db, run.id, turnsBase + t, k === undefined ? undefined : tokensBase + k),
  );
  if (!reply.ok) {
    // API/billing/rate/timeout error for THIS project — throw so the caller logs + skips it and
    // the other projects still persist their findings. Don't persist junk for this one.
    throw new Error(`audit agent turn failed: ${reply.text.slice(0, 200)}`);
  }

  const raw = parseAuditFindings(reply.text);
  const buckets: Record<string, number> = {};
  let findings = 0;
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
    const confidence = (CONFIDENCE_LEVELS as readonly string[]).includes(f.confidence ?? '')
      ? (f.confidence as string)
      : null;
    insertFinding(db, {
      runId: run.id,
      projectId: project.id,
      ticketId,
      type,
      recommendation: f.recommendation ?? null,
      reason: f.reason ?? null,
      evidence: f.evidence ?? null,
      confidence,
    });
    buckets[type] = (buckets[type] ?? 0) + 1;
    findings += 1;
  }

  return { tickets: tickets.length, findings, buckets, turns: reply.turns, tokens: reply.tokens };
}

/**
 * Run one audit pass, fanning out over every enabled project with active tickets (PD-284, D-045).
 * `scope = single:<KEY>` audits just that project (overriding its pause); otherwise it audits all
 * `audit_enabled` projects and records `scope = 'all'`. Each project gets its own agent turn,
 * wrapped so one project erroring or timing out is logged and skipped — the run continues and the
 * other projects still persist findings. Closes the run `done` with the real `counts.projects`.
 */
export async function runAuditPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  run: ClaimedRun,
  deps: AuditPassDeps = {},
): Promise<AuditRunCounts> {
  const runAgent = deps.runAgent ?? runAuditTurn;
  const buildContext = deps.buildContext ?? buildContextPack;

  // Resolve which projects this run audits from its scope.
  const singleKey = singleScopeKey(run.scope);
  let projects: AuditProject[];
  let scope: string;
  if (singleKey) {
    const p = projectByKey(db, singleKey);
    projects = p ? [p] : [];
    scope = `single:${singleKey}`;
  } else {
    projects = auditableProjects(db);
    scope = 'all';
  }

  if (projects.length === 0) {
    const counts: AuditRunCounts = { projects: 0, tickets: 0, findings: 0 };
    finishRun(db, run.id, 'done', { counts, model: config.model, scope });
    logger.info({ runId: run.id, scope }, 'audit: no project to audit — nothing to do');
    return counts;
  }

  // The context pack grounds the agent against the repo; it's identical for every project, so
  // build it once and reuse it across the fan-out.
  const contextPack = buildContext(config.checkoutDir, (what) =>
    logger.warn({ what }, 'audit: context pack is missing an expected section — the agent runs degraded'),
  );
  const systemPrompt = auditSystemPrompt(contextPack);

  const buckets: Record<string, number> = {};
  let totalTickets = 0;
  let totalFindings = 0;
  let projectsAudited = 0;
  // Running usage totals across the fan-out, so live progress and the authoritative record both
  // reflect the whole run rather than resetting per project (PD-910).
  let turnsSoFar = 0;
  let tokensSoFar = 0;

  for (const project of projects) {
    try {
      const res = await auditOneProject(db, config, run, project, systemPrompt, runAgent, turnsSoFar, tokensSoFar);
      totalTickets += res.tickets;
      totalFindings += res.findings;
      for (const [type, n] of Object.entries(res.buckets)) buckets[type] = (buckets[type] ?? 0) + n;
      if (typeof res.turns === 'number') turnsSoFar += res.turns;
      if (typeof res.tokens === 'number') tokensSoFar += res.tokens;
      projectsAudited += 1;
      // PD-910: authoritative running totals, recorded even on an unmigrated audit_run (guarded).
      try {
        recordAuditRunUsage(db, run.id, { turns: turnsSoFar, tokens: tokensSoFar });
      } catch (err) {
        logger.warn({ err, runId: run.id }, 'audit: could not record turns/tokens (audit_run not migrated yet?)');
      }
      logger.info(
        { runId: run.id, project: project.key, tickets: res.tickets, findings: res.findings },
        'audit: project complete',
      );
    } catch (err) {
      // Done-When #3: one project failing (agent error / timeout) must not abort the run.
      logger.warn({ err, runId: run.id, project: project.key }, 'audit: project errored — skipped, run continues');
    }
  }

  const counts: AuditRunCounts = { projects: projectsAudited, tickets: totalTickets, findings: totalFindings, ...buckets };
  finishRun(db, run.id, 'done', { counts, model: config.model, scope });
  logger.info({ runId: run.id, scope, ...counts }, 'audit: run complete');
  return counts;
}
