/**
 * The fault-aware retry guardrail (D-055, PD-343 / C2) — the policy engine that decides what
 * happens after a Robot run fails. It replaces C1's blind `SIMPLE_RETRY_CAP` count with a
 * three-tier fault taxonomy:
 *
 *   - **transient**    — a flake (no green verify yet, a max-turns cutoff, a network hiccup).
 *                        Worth retrying, with backoff, up to a per-ticket cap.
 *   - **deterministic**— will fail identically on every retry (a path-guard rejection, a broken
 *                        setup, or — the workhorse — the SAME failure signature seen `promoteAfter`
 *                        times). Retrying only burns budget, so park immediately and surface why.
 *   - **system-wide**  — an auth/credit fault (GitHub/Anthropic 401/403, invalid key, no credit).
 *                        It is not the ticket's fault and would fail EVERY ticket, so it must not
 *                        burn this ticket's budget; it pauses the whole loop instead.
 *
 * Motivated by #220 (a deterministic before_run failure burned every session of the retired Sortie runtime) and
 * PD-320/#202 (a board-wide auth 403 silently burned every ticket's budget). This module is pure
 * (no DB, no clock beyond an injected `now`) so the taxonomy is exhaustively unit-testable; the
 * loop (robot.ts) owns persistence and the actual state writes. C3 surfaces these tiers in the UI.
 */

export type FaultTier = 'transient' | 'deterministic' | 'system-wide';

/** A single failed run's classification. `signature` is the repeat-detection key; `reason` is the
 *  human-readable line surfaced when a ticket parks. */
export interface FaultClassification {
  tier: FaultTier;
  signature: string;
  reason: string;
}

/** A prior failed run, as the engine needs to see it for counting/backoff. */
export interface FailedRun {
  tier: FaultTier;
  signature: string;
  finishedAt: number | null;
}

/** Tunable policy (all env-driven via RobotConfig). */
export interface FaultPolicy {
  /** Max countable (non-system-wide) failures before a transient ticket parks. */
  retryCap: number;
  /** How many times an identical signature may repeat before it's promoted to deterministic. */
  promoteAfter: number;
  /** First backoff step; doubles each subsequent attempt up to `backoffMaxMs`. */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Auth / credit / quota faults — loop-wide, never the ticket's fault. Matched against error text. */
const SYSTEM_WIDE_PATTERNS: readonly RegExp[] = [
  /\b40[13]\b/, // HTTP 401 / 403
  /unauthorized|forbidden|authentication failed|not authenticated/i,
  /invalid[ _-]?(api[ _-]?key|x-api-key|token)|expired token|bad credentials/i,
  /credit balance|insufficient (credit|quota|funds)|billing|payment required/i,
];

/** Best-effort deterministic signals: things that fail identically on every retry regardless of a
 *  new attempt. The reliable deterministic path is signature-repeat promotion (below); these just
 *  let us short-circuit on the first occurrence when the signal is unambiguous. */
const DETERMINISTIC_PATTERNS: readonly RegExp[] = [
  /sensitive[- ]?path|path guard|refused to (edit|write)|blocked path|protected path/i, // D-047
  /permission denied|eacces|eperm/i, // a setup/ownership fault that won't self-heal on retry
];

/** Collapse volatile tokens (paths, numbers, hashes) so "the same failure" matches across runs. */
export function normalizeSignature(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#') // hex addresses
    .replace(/\b[0-9a-f]{7,40}\b/g, '#') // git/sha-ish hashes
    .replace(/\/[^\s'":]+/g, '/#') // absolute-ish paths
    .replace(/\d+/g, '#') // any remaining numbers (line numbers, counts, ports)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim().slice(0, 180);
}

/**
 * Classify a single failed run from what the loop observed. `error` is the SDK/thrown error text
 * (undefined for a plain no-verify, where the session ran cleanly but never reached a green verify).
 */
export function classifyFault(input: { verifyOk: boolean; error?: string | null }): FaultClassification {
  const err = (input.error ?? '').trim();

  if (err && SYSTEM_WIDE_PATTERNS.some((re) => re.test(err))) {
    return { tier: 'system-wide', signature: normalizeSignature(err), reason: `auth/credit fault (loop-wide): ${firstLine(err)}` };
  }
  if (err && DETERMINISTIC_PATTERNS.some((re) => re.test(err))) {
    return { tier: 'deterministic', signature: normalizeSignature(err), reason: `deterministic fault: ${firstLine(err)}` };
  }
  if (!err) {
    // No error text ⇒ the session ended without a green verify (D-046 gate). One occurrence is a
    // flake worth another turn; two identical ones get promoted below.
    return { tier: 'transient', signature: 'no-verify', reason: 'session ended without a green verify' };
  }
  return { tier: 'transient', signature: normalizeSignature(err), reason: `transient fault: ${firstLine(err)}` };
}

/** Exponential backoff for the Nth attempt (1-based), capped. */
export function backoffMs(attempt: number, policy: FaultPolicy): number {
  const step = policy.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(step, policy.backoffMaxMs);
}

/** Failures that count against a ticket's budget — system-wide faults are excluded (zero burn). */
function countable(failures: FailedRun[]): FailedRun[] {
  return failures.filter((f) => f.tier !== 'system-wide');
}

/** Earliest time the ticket may be retried, from its most recent countable failure + backoff.
 *  0 (immediately) when there are no countable failures. */
export function nextEligibleAt(failures: FailedRun[], policy: FaultPolicy): number {
  const c = countable(failures);
  if (c.length === 0) return 0;
  const lastFinished = c.reduce((max, f) => Math.max(max, f.finishedAt ?? 0), 0);
  return lastFinished + backoffMs(c.length, policy);
}

export type FaultDecision =
  | { action: 'retry'; tier: FaultTier; signature: string; reason: string }
  | { action: 'park'; tier: FaultTier; signature: string; reason: string }
  | { action: 'pause'; tier: FaultTier; signature: string; reason: string };

/**
 * Decide what to do after a FRESH failure, given the ticket's PRIOR failures.
 *   - system-wide  → pause the loop (this run does not count against the ticket).
 *   - deterministic→ park now (0 retries).
 *   - transient    → promote to deterministic-park if this signature has now repeated
 *                    `promoteAfter` times; else park if the cap is hit; else retry.
 */
export function decideFault(cls: FaultClassification, priorFailures: FailedRun[], policy: FaultPolicy): FaultDecision {
  if (cls.tier === 'system-wide') return { action: 'pause', ...cls };
  if (cls.tier === 'deterministic') return { action: 'park', ...cls };

  const prior = countable(priorFailures);
  const sameSig = prior.filter((f) => f.signature === cls.signature).length + 1; // include this run
  if (sameSig >= policy.promoteAfter) {
    return {
      action: 'park',
      tier: 'deterministic',
      signature: cls.signature,
      reason: `promoted transient→deterministic: identical failure repeated ${sameSig}× — ${cls.reason}`,
    };
  }
  const total = prior.length + 1;
  if (total >= policy.retryCap) {
    return { action: 'park', tier: 'transient', signature: cls.signature, reason: `retry cap reached (${total}/${policy.retryCap}) — ${cls.reason}` };
  }
  return { action: 'retry', ...cls };
}

export type Preflight =
  | { action: 'go' }
  | { action: 'backoff'; until: number }
  | { action: 'park'; reason: string };

/**
 * Pre-dispatch gate, from history alone (no new run yet). Parks a ticket whose budget is already
 * spent (so we never waste a run re-confirming it), and holds a ticket inside its backoff window.
 * Belt-and-suspenders to `decideFault`: a ticket that parked post-run has `agent_state != queued`
 * and won't be selected, but an externally re-queued ticket still gets the same ceiling.
 */
export function preflight(failures: FailedRun[], policy: FaultPolicy, now: number): Preflight {
  const c = countable(failures);

  const det = c.find((f) => f.tier === 'deterministic');
  if (det) return { action: 'park', reason: `deterministic fault already recorded: ${det.signature}` };

  const counts = new Map<string, number>();
  for (const f of c) counts.set(f.signature, (counts.get(f.signature) ?? 0) + 1);
  for (const [sig, n] of counts) {
    if (n >= policy.promoteAfter) return { action: 'park', reason: `identical failure repeated ${n}×: ${sig}` };
  }

  if (c.length >= policy.retryCap) return { action: 'park', reason: `retry cap reached (${c.length}/${policy.retryCap})` };

  const until = nextEligibleAt(failures, policy);
  if (now < until) return { action: 'backoff', until };

  return { action: 'go' };
}
