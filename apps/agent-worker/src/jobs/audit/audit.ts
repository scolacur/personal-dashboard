import type Database from 'better-sqlite3';
import {
  auditSystemPrompt,
  auditVerifySystemPrompt,
  RELATION_TYPES,
  type AuditRunCounts,
  type RelationType,
} from '@dashboard/shared';
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
  projectByKey,
  recordAuditRunUsage,
  updateAuditRunProgress,
  type AuditableTicket,
  type AuditProject,
  type AuditRelation,
  type AuditRunUsage,
  type ClaimedRun,
  type FindingInput,
} from './audit-db';
import { runAuditTurn, type AuditProgress, type AuditTurnResult, type AuditTurnUsage } from './audit-agent';
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

/** Rank a confidence so the verify stage can only ever LOWER it (PD-284). null (unset) is the floor. */
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
function confidenceRank(c: string | null): number {
  return c ? (CONFIDENCE_RANK[c] ?? 0) : 0;
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

/** An agent turn runner — the fan-out and the verify stage both use this shape (one read-only Agent
 *  SDK turn against a system + user prompt). Defaults to {@link runAuditTurn}. */
type RunAuditAgent = (
  config: AgentWorkerConfig,
  systemPrompt: string,
  prompt: string,
  onProgress?: AuditProgress,
) => Promise<AuditTurnResult>;

/** Injectable seams so the pass is unit-testable without a live agent or a real checkout. */
export interface AuditPassDeps {
  runAgent?: RunAuditAgent;
  /** The adversarial verify turn (PD-284). Defaults to `runAgent` — the same runner with the verify
   *  system prompt — so a test that stubs `runAgent` controls verify too unless it overrides this. */
  runVerify?: RunAuditAgent;
  buildContext?: (checkoutDir: string, onMissing?: (what: string) => void) => string;
}

/**
 * A finding resolved by the fan-out and ready to persist, held in memory until the verify stage has
 * run (PD-284). Persistence is deferred to the end of the run so the pooled verify pass can DROP or
 * DOWNGRADE a candidate before it is ever written — survivors only are inserted. `isKeep` findings
 * (type `keep`) skip verify entirely and are always persisted.
 */
interface PendingFinding {
  input: FindingInput;
  isKeep: boolean;
  /** For the verify prompt: the project name and the subject/target display ids. */
  projectName: string;
  subjectLabel: string;
  targetLabel: string | null;
}

/** One verify verdict as the verify agent emits it (PD-284). `index` references a candidate; any
 *  unrecognised shape is ignored (the candidate is left upheld). */
interface VerifyVerdict {
  index?: number;
  verdict?: string;
  confidence?: string;
}

/**
 * Parse the verify agent's reply into verdicts. Same tolerant extraction as `parseAuditFindings`:
 * pulls the last JSON array out of the text (bare or fenced), returns [] on anything unparseable.
 */
export function parseVerifyVerdicts(text: string): VerifyVerdict[] {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  if (!candidate || candidate.indexOf('[') === -1) return [];
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? (parsed as VerifyVerdict[]) : [];
  } catch {
    return [];
  }
}

/** Render the pooled list of non-`keep` candidates for the verify agent — one block per candidate,
 *  keyed by its integer index so the verdicts can reference it. */
function verifyPrompt(candidates: PendingFinding[]): string {
  const blocks = candidates.map((c, i) => {
    const f = c.input;
    const rel = c.targetLabel ? ` → ${c.targetLabel} (${f.relationType ?? 'relation'})` : '';
    return [
      `[${i}] project: ${c.projectName} | subject: ${c.subjectLabel} | type: ${f.type}${rel}`,
      `    recommendation: ${f.recommendation ?? '(none)'}`,
      `    reason: ${f.reason ?? '(none)'}`,
      `    evidence: ${f.evidence ?? '(none)'}`,
      `    confidence: ${f.confidence ?? '(unset)'}`,
    ].join('\n');
  });
  return [
    `Review these ${candidates.length} candidate audit findings. For EACH, check its cited evidence`,
    'against the checkout and return a verdict (uphold / downgrade / drop) as a JSON array. Drop only',
    'the ones the evidence cannot defensibly support.',
    '',
    ...blocks,
  ].join('\n');
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

/** The outcome of auditing one project: its RESOLVED candidate findings (not yet persisted — the
 *  pooled verify stage filters them first, PD-284), plus the usage its turn spent. */
interface ProjectPassResult {
  tickets: number;
  turns?: number;
  tokens?: number;
  usage?: AuditTurnUsage;
  pending: PendingFinding[];
}

/**
 * Audit ONE project: ask the agent to bucket its active tickets, then RESOLVE the findings with
 * their confidence (PD-284), relation findings (PD-828), and cross-run carry-forward decisions
 * (PD-285). Returns the resolved candidates WITHOUT persisting them — the caller pools them across
 * projects, runs the adversarial verify stage, and persists survivors only (PD-284). Throws on an
 * agent error so the caller's try/catch treats the project as failed-and-skipped (Done-When #3) — it
 * never aborts the whole run. Advisory only — never mutates a ticket (D-045 guardrail).
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
  runAgent: RunAuditAgent,
  turnsBase: number,
  tokensBase: number,
): Promise<ProjectPassResult> {
  const tickets = getAuditableTickets(db, project.id);
  const byDisplayId = new Map(tickets.filter((t) => t.displayId).map((t) => [t.displayId as string, t.id]));
  const validIds = new Set(tickets.map((t) => t.id));
  // id → display label (`PD-10` or `#10`), for the verify prompt. Covers audited tickets; relation
  // far ends are added below so a relation finding's target still renders a real id.
  const labelById = new Map<number, string>(tickets.map((t) => [t.id, t.displayId ?? `#${t.id}`]));

  // PD-828 / D-120: existing relations read as truth. Group by audited subject for the prompt; build
  // a target-resolution map that ALSO knows each relation's far end (so an `unlink` of a stale link
  // to an already-archived ticket still resolves its target — D-120); and an edge set for link de-dup.
  const relations = getRelationsForTickets(db, [...validIds]);
  const relationsBySubject = new Map<number, AuditRelation[]>();
  const targetByDisplayId = new Map(byDisplayId);
  const existingEdges = new Set<string>();
  const edgeKey = (from: number, to: number, type: string): string => `${from}:${to}:${type}`;
  for (const r of relations) {
    (relationsBySubject.get(r.subjectId) ?? relationsBySubject.set(r.subjectId, []).get(r.subjectId)!).push(r);
    if (r.otherDisplayId) targetByDisplayId.set(r.otherDisplayId, r.otherId);
    labelById.set(r.otherId, r.otherDisplayId ?? `#${r.otherId}`);
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
  const label = (id: number): string => labelById.get(id) ?? `#${id}`;
  const pending: PendingFinding[] = [];

  // Resolve + fingerprint every single-ticket finding we can tie to an audited ticket, THEN
  // reconcile the whole set against the prior run (PD-285). Reconciliation is batch, not per-row:
  // it keys on (ticket_id, type), so it needs the current run's full set before deciding
  // carry-forward. Relation findings (PD-828) are not reconciled here — their match key is
  // (from, to, relation_type), deferred to PD-288.
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
      pending.push({
        input: {
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
        },
        isKeep: false, // a relation finding is never a `keep`
        projectName: project.name,
        subjectLabel: label(ticketId),
        targetLabel: label(targetId),
      });
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
    pending.push({
      input: {
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
      },
      isKeep: r.type === 'keep', // a `keep` is recorded but never challenged by verify
      projectName: project.name,
      subjectLabel: label(r.ticketId),
      targetLabel: null,
    });
  });

  return { tickets: tickets.length, pending, turns: reply.turns, tokens: reply.tokens, usage: reply.usage };
}

/**
 * Add a turn's usage into the run's running total (PD-284). A turn with no `usage` (e.g. a stubbed
 * agent) contributes nothing.
 */
function addUsage(total: AuditRunUsage, turn: AuditTurnUsage | undefined): void {
  if (!turn) return;
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.totalTokens += turn.totalTokens;
  total.costUsd += turn.costUsd;
}

/**
 * Apply the verify stage's verdicts to the pooled non-`keep` candidates (PD-284). Returns the set of
 * DROPPED candidates and mutates a surviving candidate's confidence on a `downgrade`. The verify
 * stage can only ever remove or weaken — it never raises confidence and never resurrects a dropped
 * finding (a candidate it is silent about is upheld as-is). See D-122.
 */
function applyVerifyVerdicts(nonKeep: PendingFinding[], verdicts: VerifyVerdict[]): Set<PendingFinding> {
  const byIndex = new Map<number, VerifyVerdict>();
  for (const v of verdicts) if (typeof v.index === 'number') byIndex.set(v.index, v);
  const dropped = new Set<PendingFinding>();
  nonKeep.forEach((c, i) => {
    const v = byIndex.get(i);
    if (!v) return; // omitted = upheld
    if (v.verdict === 'drop') {
      dropped.add(c);
      return;
    }
    if (v.verdict === 'downgrade') {
      const next = toConfidence(v.confidence);
      // Only ever LOWER confidence; ignore a missing/invalid value or one that would raise it.
      if (next && confidenceRank(next) < confidenceRank(c.input.confidence ?? null)) {
        c.input.confidence = next;
      }
    }
    // uphold / unknown verdict → keep as-is.
  });
  return dropped;
}

/**
 * Run one audit pass, fanning out over every enabled project with active tickets (PD-284, D-045).
 * `scope = single:<KEY>` audits just that project (overriding its pause); otherwise it audits all
 * `audit_enabled` projects and records `scope = 'all'`. Each project gets its own agent turn,
 * wrapped so one project erroring or timing out is logged and skipped — the run continues.
 *
 * Findings are RESOLVED in memory, then a single pooled adversarial verify turn (PD-284, D-122)
 * reviews every non-`keep` candidate across all projects and DROPS or DOWNGRADES the ones the
 * evidence does not support; survivors only are persisted, and the stage fails open (a verify error
 * keeps all candidates). Per-run token/cost usage is summed across the fan-out turns plus the verify
 * turn and written on finish. Closes the run `done` with the real counts.
 */
export async function runAuditPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  run: ClaimedRun,
  deps: AuditPassDeps = {},
): Promise<AuditRunCounts> {
  const runAgent = deps.runAgent ?? runAuditTurn;
  // Verify reuses the same runner shape with a different system prompt. Defaulting to `runAgent`
  // means a test that stubs the fan-out controls verify too unless it overrides `runVerify`.
  const runVerify = deps.runVerify ?? runAgent;
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
  // build it once and reuse it across the fan-out and the verify stage.
  const contextPack = buildContext(config.checkoutDir, (what) =>
    logger.warn({ what }, 'audit: context pack is missing an expected section — the agent runs degraded'),
  );
  const systemPrompt = auditSystemPrompt(contextPack);

  let totalTickets = 0;
  let projectsAudited = 0;
  // Running usage totals across the fan-out, so live progress and the authoritative record both
  // reflect the whole run rather than resetting per project (PD-910).
  let turnsSoFar = 0;
  let tokensSoFar = 0;
  // PD-284: authoritative token/cost totals summed across every agent turn (fan-out + verify).
  const usage: AuditRunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  // Candidate findings from every project, in run order. Persisted only after the verify stage.
  const allPending: PendingFinding[] = [];

  const recordLiveUsage = (): void => {
    // PD-910: authoritative running totals, recorded even on an unmigrated audit_run (guarded).
    try {
      recordAuditRunUsage(db, run.id, { turns: turnsSoFar, tokens: tokensSoFar });
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'audit: could not record turns/tokens (audit_run not migrated yet?)');
    }
  };

  for (const project of projects) {
    try {
      const res = await auditOneProject(db, config, run, project, systemPrompt, runAgent, turnsSoFar, tokensSoFar);
      totalTickets += res.tickets;
      allPending.push(...res.pending);
      if (typeof res.turns === 'number') turnsSoFar += res.turns;
      if (typeof res.tokens === 'number') tokensSoFar += res.tokens;
      addUsage(usage, res.usage);
      projectsAudited += 1;
      recordLiveUsage();
      logger.info(
        { runId: run.id, project: project.key, tickets: res.tickets, candidates: res.pending.length },
        'audit: project complete',
      );
    } catch (err) {
      // Done-When #3: one project failing (agent error / timeout) must not abort the run.
      logger.warn({ err, runId: run.id, project: project.key }, 'audit: project errored — skipped, run continues');
    }
  }

  // Adversarial verify stage (PD-284): ONE pooled turn across every non-`keep` candidate. It drops
  // or downgrades; survivors only are persisted. Fail-open — if verify errors or the agent fails,
  // keep every candidate as-is rather than discard the fan-out's advisory signal. Skipped entirely
  // when there is nothing to challenge, so it costs no turn.
  const nonKeep = allPending.filter((p) => !p.isKeep);
  let dropped = new Set<PendingFinding>();
  if (nonKeep.length > 0) {
    try {
      const reply = await runVerify(
        config,
        auditVerifySystemPrompt(contextPack),
        verifyPrompt(nonKeep),
        (t, k) => updateAuditRunProgress(db, run.id, turnsSoFar + t, k === undefined ? undefined : tokensSoFar + k),
      );
      if (reply.ok) {
        dropped = applyVerifyVerdicts(nonKeep, parseVerifyVerdicts(reply.text));
      } else {
        logger.warn({ runId: run.id, text: reply.text.slice(0, 200) }, 'audit: verify turn failed — keeping all candidates');
      }
      if (typeof reply.turns === 'number') turnsSoFar += reply.turns;
      if (typeof reply.tokens === 'number') tokensSoFar += reply.tokens;
      addUsage(usage, reply.usage);
      recordLiveUsage();
    } catch (err) {
      logger.warn({ err, runId: run.id }, 'audit: verify stage errored — keeping all candidates');
    }
  }

  // Persist survivors in run order (dropped candidates are never written — never resurrected).
  const buckets: Record<string, number> = {};
  let totalFindings = 0;
  for (const p of allPending) {
    if (dropped.has(p)) continue;
    insertFinding(db, p.input);
    buckets[p.input.type] = (buckets[p.input.type] ?? 0) + 1;
    totalFindings += 1;
  }

  const counts: AuditRunCounts = { projects: projectsAudited, tickets: totalTickets, findings: totalFindings, ...buckets };
  finishRun(db, run.id, 'done', { counts, model: config.model, scope, usage });
  logger.info({ runId: run.id, scope, ...counts, costUsd: usage.costUsd }, 'audit: run complete');
  return counts;
}
