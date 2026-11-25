import { createHash } from 'node:crypto';
import type { FindingDecision } from '@dashboard/shared';

// PD-285: cross-run reconciliation under the snapshot + carry-forward model (chosen 2026-11-21).
// Every audit run keeps writing fresh `audit_finding` rows; this module decides, for each
// freshly-computed finding, which `decision` it inherits from the prior run. Pure — no DB, no
// agent — so it is unit-testable in isolation (the shared package has no vitest runner, and this
// is worker-only logic anyway). Scope is SINGLE-TICKET findings only, matched on (ticket_id, type);
// relation findings (from, to, relation_type) are PD-288 and will extend the match key.

/** Collapse runs of whitespace and trim, so cosmetic reformatting of the agent's prose doesn't
 *  change the fingerprint (and thus doesn't needlessly resurface a suppressed finding). */
function normalize(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** A stable hash of a finding's identity-for-decision: its `type`, its normalized `evidence`, and
 *  its normalized `proposed_change`. Same inputs → same fingerprint across runs/processes. Fields
 *  are JSON-encoded before hashing so no field value can be mistaken for a separator — ('ab','')
 *  and ('a','b') hash differently. */
export function findingFingerprint(input: {
  type: string;
  evidence?: string | null;
  proposedChange?: string | null;
}): string {
  const parts = [input.type, normalize(input.evidence), normalize(input.proposedChange)];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A prior run's finding, as read back for reconciliation. */
export interface PriorFinding {
  ticketId: number | null;
  type: string;
  fingerprint: string | null;
  decision: FindingDecision;
}

/** A freshly-computed finding of the current run, before its decision is resolved. */
export interface CurrentFinding {
  ticketId: number | null;
  type: string;
  fingerprint: string;
}

/** Match key for single-ticket findings (PD-285): (ticket_id, type). JSON-encoded so a numeric id
 *  and a type string can't collide across the boundary. */
function matchKey(f: { ticketId: number | null; type: string }): string {
  return JSON.stringify([f.ticketId, f.type]);
}

/**
 * Resolve the `decision` each current finding should carry, in the same order as `current`:
 *  - prior match (same (ticket_id, type)) with the SAME fingerprint → carry its decision forward
 *    (this is what makes an accepted/rejected decision survive a re-run, and what suppresses a
 *    `rejected` finding so it never re-enters the actionable set);
 *  - prior match with a CHANGED fingerprint → `undecided` (the evidence moved; the old call no
 *    longer applies, so a suppressed finding resurfaces);
 *  - no prior match → `undecided` (a new finding);
 *  - a prior finding with no current match is simply not represented here = closed-by-omission.
 */
export function reconcileDecisions(prior: PriorFinding[], current: CurrentFinding[]): FindingDecision[] {
  const priorByKey = new Map<string, PriorFinding>();
  for (const p of prior) priorByKey.set(matchKey(p), p);
  return current.map((c) => {
    const match = priorByKey.get(matchKey(c));
    if (!match) return 'undecided';
    return match.fingerprint === c.fingerprint ? match.decision : 'undecided';
  });
}
