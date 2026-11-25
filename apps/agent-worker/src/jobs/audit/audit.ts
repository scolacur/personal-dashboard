import type Database from 'better-sqlite3';
import { auditSystemPrompt, RELATION_TYPES, type AuditRunCounts, type RelationType } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import {
  finishRun,
  firstProjectWithActiveTickets,
  getAuditableTickets,
  getRelationsForTickets,
  insertFinding,
  recordAuditRunUsage,
  updateAuditRunProgress,
  type AuditableTicket,
  type AuditRelation,
  type ClaimedRun,
} from './audit-db';
import { runAuditTurn, type AuditProgress } from './audit-agent';

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

/** A finding as the agent emits it (before we resolve the ticket + persist). For a relation finding
 *  (PD-828) `target` names the other end (displayId) and `relationType` the edge type. */
interface RawFinding {
  ticketId?: number;
  displayId?: string;
  type?: string;
  recommendation?: string;
  reason?: string;
  evidence?: string;
  proposedChange?: string;
  target?: string;
  relationType?: string;
}

/**
 * Resolve the `relation_type` a relation finding persists with (PD-828), or null if it can't:
 *  - `duplicate` is always the `duplicates` edge;
 *  - `link` proposes `relates` or `blocks` (anything else defaults to the softer `relates`);
 *  - `unlink` must name an existing relation type (any of RELATION_TYPES), else we drop it — a
 *    relation finding with no type is not actionable (Done-When #3: both ends resolved).
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

  const contextPack = buildContext(config.checkoutDir, (what) =>
    logger.warn({ what }, 'audit: context pack is missing an expected section — the agent runs degraded'),
  );
  const systemPrompt = auditSystemPrompt(contextPack);
  const reply = await runAgent(config, systemPrompt, ticketsPrompt(project.name, tickets, relationsBySubject), (t, k) =>
    updateAuditRunProgress(db, run.id, t, k),
  );
  // PD-910: authoritative totals, recorded even when the turn failed (spend is spend). Guarded: a
  // not-yet-migrated audit_run must never turn a finished audit into an errored one.
  try {
    recordAuditRunUsage(db, run.id, { turns: reply.turns, tokens: reply.tokens });
  } catch (err) {
    logger.warn({ err, runId: run.id }, 'audit: could not record turns/tokens (audit_run not migrated yet?)');
  }
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

    if (f.type && isRelationFinding(f.type)) {
      // Relation finding (PD-828). Resolve the other end against the audited set OR the far end of
      // an existing relation, resolve the relation type, and drop anything that leaves a null — a
      // relation finding is only actionable with both ends + a type (Done-When #3).
      const targetId =
        f.target && targetByDisplayId.has(f.target) ? (targetByDisplayId.get(f.target) as number) : null;
      if (targetId === null || targetId === ticketId) continue;
      const relationType = resolveRelationType(f.type, f.relationType);
      if (relationType === null) continue;
      // Never re-emit a link that already exists (Done-When #2); `unlink`/`duplicate` act on
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
      });
      buckets[f.type] = (buckets[f.type] ?? 0) + 1;
      persisted += 1;
      continue;
    }

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
