import type Database from 'better-sqlite3';
import { auditSystemPrompt, RELATION_TYPES, type AuditRunCounts, type RelationType } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import {
  auditableProjects,
  finishRun,
  getAuditableTickets,
  getPriorFindings,
  getRelationsForTickets,
  insertFinding,
  notifyAuditComplete,
  projectByKey,
  recordAuditRunUsage,
  updateAuditRunProgress,
  type AuditableTicket,
  type AuditProject,
  type AuditRelation,
  type ClaimedRun,
} from './audit-db';
import { runAuditTurn, type AuditProgress } from './audit-agent';
import { findingFingerprint, reconcileDecisions, type CurrentFinding } from './reconcile';

// Single-ticket recommendation buckets the audit agent may emit (D-045). 'keep' = no action needed;
// it's recorded so a re-run can show the ticket was reviewed and deliberately left alone.
const FINDING_TYPES = ['archive', 'complete', 'reprioritize', 'update', 'keep'] as const;

// Relation findings (PD-828): advisory only here — the apply path that writes a relation is Child B.
//   link      — propose a new `relates` OR `blocks` edge (relation_type says which)
//   unlink    — remove an existing relation (relation_type names which existing link)
//   duplicate — the subject is a duplicate of the target (a `duplicates` edge + duplicate-archive)
const RELATION_FINDING_TYPES = ['link', 'unlink', 'duplicate'] as const;
function isRelationFinding(type: string): boolean {
  return (RELATION_FINDING_TYPES as readonly string[]).includes(type);
}

/** How sure the agent is about a finding (PD-284). Anything off this list is dropped to null. */
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
function toConfidence(raw: string | undefined): string | null {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(raw ?? '') ? (raw as string) : null;
}

/** A finding as the agent emits it (before we resolve the ticket + persist). For a relation finding
 *  (PD-828) `target` names the other end (displayId) and `relationType` the edge type; `confidence`
 *  (PD-284) is how sure the agent is. */
interface RawFinding {
  ticketId?: number;
  displayId?: string;
  type?: string;
  recommendation?: string;
  reason?: string;
  evidence?: string;
  proposedChange?: string;
  confidence?: string;
  target?: string;
  relationType?: string;
}

/**
 * Resolve the `relation_type` a relation finding persists with (PD-828), or null if it can't:
 *  - `duplicate` is always the `duplicates` edge;
 *  - `link` proposes `relates` or `blocks` (anything else defaults to the softer `relates`);
 *  - `unlink` must name an existing relation type (any of RELATION_TYPES), else we drop it — a
 *    relation finding with no type is not actionable.
 */
function resolveRelationType(findingType: string, raw: string | undefined): RelationType | null {
  if (findingType === 'duplicate') return 'duplicates';
  if (findingType === 'link') return raw === 'blocks' ? 'blocks' : 'relates';
  return (RELATION_TYPES as readonly string[]).includes(raw ?? '') ? (raw as RelationType) : null;
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

/** One line per existing relation on a ticket, so the agent treats relations as truth and does not
 *  re-propose a link that already exists (PD-828). Rendered as "subject <verb> OTHER" so the agent
 *  reads each from the audited ticket's point of view. */
function relationLines(subject: AuditableTicket, relations: AuditRelation[]): string[] {
  const label = subject.displayId ?? `#${subject.id}`;
  return relations.map((r) => {
    const other = r.otherDisplayId ?? `#${r.otherId}`;
    const otherStatus = r.otherStatus ? ` (${r.otherStatus})` : '';
    // `direction: 'from'` = subject is the from side of the edge.
    const phrase =
      r.type === 'blocks'
        ? r.direction === 'from'
          ? `${label} blocks ${other}`
          : `${label} is blocked by ${other}`
        : r.type === 'duplicates'
          ? r.direction === 'from'
            ? `${label} duplicates ${other}`
            : `${label} is duplicated by ${other}`
          : r.type === 'split'
            ? r.direction === 'from'
              ? `${label} was split into ${other}`
              : `${label} was split from ${other}`
            : `${label} relates to ${other}`;
    return `    relation: ${phrase}${otherStatus}`;
  });
}

function ticketsPrompt(
  projectName: string,
  tickets: AuditableTicket[],
  relationsBySubject: Map<number, AuditRelation[]>,
): string {
  const lines = tickets.flatMap((t) => {
    const head = `- ${t.displayId ?? `#${t.id}`} [${t.status}/${t.priority}] ${t.title}\n    ${(t.body ?? '').slice(0, 500).replace(/\n/g, ' ')}`;
    return [head, ...relationLines(t, relationsBySubject.get(t.id) ?? [])];
  });
  return [
    `Audit these ${tickets.length} active tickets in project "${projectName}". Cross-reference`,
    'the checkout to decide each one, then return the JSON findings array.',
    'Each "relation:" line below is an EXISTING link — treat it as truth; never re-propose it as a',
    'new `link` finding (you may still `unlink` a stale one).',
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
 * Audit ONE project: ask the agent to bucket its active tickets, then persist the findings with
 * their confidence (PD-284), relation findings (PD-828), and cross-run carry-forward decisions
 * (PD-285). Returns the per-project tallies. Throws on an agent error so the caller's try/catch
 * treats the project as failed-and-skipped (Done-When #3) — it never aborts the whole run. Advisory
 * only — never mutates a ticket (D-045 guardrail).
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

  // PD-828 / D-120: existing relations read as truth. Group by audited subject for the prompt; build
  // a target-resolution map that ALSO knows each relation's far end (so an `unlink` of a stale link
  // to an already-archived ticket still resolves its target — D-120); and an edge set for link de-dup.
  const relations = getRelationsForTickets(db, [...validIds]);
  const relationsBySubject = new Map<number, AuditRelation[]>();
  const targetByDisplayId = new Map(byDisplayId);
  const targetValidIds = new Set(validIds);
  const existingEdges = new Set<string>();
  const edgeKey = (from: number, to: number, type: string): string => `${from}:${to}:${type}`;
  for (const r of relations) {
    (relationsBySubject.get(r.subjectId) ?? relationsBySubject.set(r.subjectId, []).get(r.subjectId)!).push(r);
    targetValidIds.add(r.otherId);
    if (r.otherDisplayId) targetByDisplayId.set(r.otherDisplayId, r.otherId);
    const [from, to] = r.direction === 'from' ? [r.subjectId, r.otherId] : [r.otherId, r.subjectId];
    existingEdges.add(edgeKey(from, to, r.type));
    // `relates` is semantically symmetric but stored directionally — record both orderings so a
    // re-proposed link in either direction is recognised as already present.
    if (r.type === 'relates') existingEdges.add(edgeKey(to, from, r.type));
  }

  const reply = await runAgent(
    config,
    systemPrompt,
    ticketsPrompt(project.name, tickets, relationsBySubject),
    (t, k) => updateAuditRunProgress(db, run.id, turnsBase + t, k === undefined ? undefined : tokensBase + k),
  );
  if (!reply.ok) {
    // API/billing/rate/timeout error for THIS project — throw so the caller logs + skips it and
    // the other projects still persist their findings. Don't persist junk for this one.
    throw new Error(`audit agent turn failed: ${reply.text.slice(0, 200)}`);
  }

  const raw = parseAuditFindings(reply.text);

  const buckets: Record<string, number> = {};
  let findings = 0;

  // Resolve + fingerprint every single-ticket finding we can tie to an audited ticket, THEN
  // reconcile the whole set against the prior run (PD-285). Reconciliation is batch, not per-row:
  // it keys on (ticket_id, type), so it needs the current run's full set before deciding
  // carry-forward. Relation findings (PD-828) are not reconciled here — their match key is
  // (from, to, relation_type), deferred to PD-288 — so they are persisted inline as before.
  interface Resolved {
    ticketId: number;
    type: string;
    recommendation: string | null;
    reason: string | null;
    evidence: string | null;
    proposedChange: string | null;
    confidence: string | null;
    fingerprint: string;
  }
  const resolved: Resolved[] = [];
  for (const f of raw) {
    // Resolve the ticket the finding is about; drop findings we can't tie to an audited ticket.
    const ticketId =
      typeof f.ticketId === 'number' && validIds.has(f.ticketId)
        ? f.ticketId
        : f.displayId && byDisplayId.has(f.displayId)
          ? (byDisplayId.get(f.displayId) as number)
          : null;
    if (ticketId === null) continue;

    if (f.type && isRelationFinding(f.type)) {
      // Relation finding (PD-828). Resolve the other end against the audited set OR the far end of
      // an existing relation, resolve the relation type, and drop anything that leaves a null — a
      // relation finding is only actionable with both ends + a type.
      const targetId =
        f.target && targetByDisplayId.has(f.target) ? (targetByDisplayId.get(f.target) as number) : null;
      if (targetId === null || targetId === ticketId) continue;
      const relationType = resolveRelationType(f.type, f.relationType);
      if (relationType === null) continue;
      // Never re-emit a link that already exists (PD-828); `unlink`/`duplicate` act on
      // existing/archival state, so they are not de-duped against existing edges.
      if (f.type === 'link' && existingEdges.has(edgeKey(ticketId, targetId, relationType))) continue;
      insertFinding(db, {
        runId: run.id,
        projectId: project.id,
        ticketId,
        targetTicketId: targetId,
        relationType,
        type: f.type,
        recommendation: f.recommendation ?? null,
        reason: f.reason ?? null,
        evidence: f.evidence ?? null,
        confidence: toConfidence(f.confidence),
      });
      buckets[f.type] = (buckets[f.type] ?? 0) + 1;
      findings += 1;
      continue;
    }

    const type = (FINDING_TYPES as readonly string[]).includes(f.type ?? '') ? (f.type as string) : 'update';
    const evidence = f.evidence ?? null;
    const proposedChange = f.proposedChange ?? null;
    resolved.push({
      ticketId,
      type,
      recommendation: f.recommendation ?? null,
      reason: f.reason ?? null,
      evidence,
      proposedChange,
      confidence: toConfidence(f.confidence),
      fingerprint: findingFingerprint({ type, evidence, proposedChange }),
    });
  }

  // Carry-forward decisions from the most recent prior `done` run for this project (PD-285): an
  // unchanged fingerprint keeps accepted/rejected; a changed one (or no prior) → undecided. A prior
  // finding with no current match is absent here = closed-by-omission.
  const prior = getPriorFindings(db, project.id);
  const current: CurrentFinding[] = resolved.map((r) => ({
    ticketId: r.ticketId,
    type: r.type,
    fingerprint: r.fingerprint,
  }));
  const decisions = reconcileDecisions(prior, current);

  resolved.forEach((r, i) => {
    insertFinding(db, {
      runId: run.id,
      projectId: project.id,
      ticketId: r.ticketId,
      type: r.type,
      recommendation: r.recommendation,
      reason: r.reason,
      evidence: r.evidence,
      proposedChange: r.proposedChange,
      confidence: r.confidence,
      fingerprint: r.fingerprint,
      decision: decisions[i],
    });
    buckets[r.type] = (buckets[r.type] ?? 0) + 1;
    findings += 1;
  });

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
  // PD-851: notify once per run when it surfaced ≥1 actionable finding; collapses to one unread.
  notifyAuditComplete(db, run.id);
  logger.info({ runId: run.id, scope, ...counts }, 'audit: run complete');
  return counts;
}
