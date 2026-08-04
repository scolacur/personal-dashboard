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
  /** PD-470: for a session-limit fault only — when the provider says the quota resets, epoch ms,
   *  or null when the message carried no readable time. */
  resetAt?: number | null;
}

/** A prior failed run, as the engine needs to see it for counting/backoff. */
export interface FailedRun {
  tier: FaultTier;
  signature: string;
  finishedAt: number | null;
  /** Hash of the ticket body this run ran against (PD-406) — lets a max-turns fault tell an
   *  unchanged-body retry (futile → park) from a genuinely re-scoped one. Null for legacy rows. */
  bodyHash?: string | null;
}

/** The stable signature for a per-run turn-limit cutoff (PD-406). Set explicitly (not derived via
 *  `normalizeSignature`) so it's a reliable key for the unchanged-body deterministic promotion. */
export const MAX_TURNS_SIGNATURE = 'max-turns';

/** The stable signature for a provider session/usage limit (PD-470). Explicit for the same reason
 *  as `MAX_TURNS_SIGNATURE`: the raw text carries a reset time, so a normalized signature would
 *  differ run to run and defeat every same-signature rule we want to apply to it. */
export const SESSION_LIMIT_SIGNATURE = 'session-limit';

/** "You've hit your session limit · resets 5:30am (UTC)" and its usage-limit variants. Deliberately
 *  narrow: a generic 429/rate-limit is NOT this — this is the subscription quota, which recovers on
 *  a schedule the message itself states. */
const SESSION_LIMIT_PATTERN = /\b(session|usage)[ _-]?limit\b|hit your limit/i;

/** How long to hold when a session limit is reported but its reset time can't be read. Bounded on
 *  purpose (PD-470): an unparseable variant must degrade to "try again shortly", never to an
 *  indefinite wait for a human. */
export const SESSION_LIMIT_FALLBACK_MS = 15 * 60_000;

/** Longest wait a PARSED reset time may produce. A quota reset is hours away at most, so anything
 *  beyond this means the parse went wrong (wrong day, wrong timezone) — fall back to the bounded
 *  delay rather than trusting it and stalling the loop until tomorrow. */
export const SESSION_LIMIT_MAX_WAIT_MS = 12 * 60 * 60_000;

/**
 * Read the reset time out of a session-limit error, as epoch ms — `null` when it can't be read.
 *
 * Defensive by construction (PD-470): the provider's phrasing is not a contract, so every branch
 * that isn't confidently understood returns null and lets the caller use the bounded fallback. A
 * bare hour is read as 24h; `(UTC)`/`(GMT)` switches the whole computation to UTC, anything else
 * (including an absent parenthetical) is local. A time that has already passed today is read as
 * tomorrow's — "resets 5:30am" at 21:45 means the 5:30am that is 7¾ hours out, not the one 16 hours
 * ago.
 */
export function parseResetAt(error: string, now: number): number | null {
  const m = /reset(?:s|ting)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]{1,40})\))?/i.exec(error);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  const utc = /\b(utc|gmt)\b/i.test(m[4] ?? '');

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null; // e.g. "resets 25:00" — not a time we understand

  const base = new Date(now);
  const at = utc
    ? Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, 0, 0)
    : new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();

  const target = at <= now ? at + 24 * 60 * 60_000 : at;
  if (target - now > SESSION_LIMIT_MAX_WAIT_MS) return null;
  return target;
}

/** "Reached maximum number of turns (N)" — the Agent SDK's per-run turn-ceiling error. */
const MAX_TURNS_PATTERN = /maximum number of turns|max_turns|reached the turn limit/i;

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
export function classifyFault(
  input: { verifyOk: boolean; error?: string | null },
  now: number = Date.now(),
): FaultClassification {
  const err = (input.error ?? '').trim();

  // PD-470: checked BEFORE the auth/credit patterns. A session limit reads like a credit fault but
  // behaves nothing like one — it is not a broken credential a human must fix, it is a wait with a
  // stated end. Classifying it first is what stops it being handled as "pause until someone looks".
  if (err && SESSION_LIMIT_PATTERN.test(err)) {
    const resetAt = parseResetAt(err, now);
    return {
      tier: 'transient',
      signature: SESSION_LIMIT_SIGNATURE,
      reason: `provider session limit: ${firstLine(err)}`,
      resetAt,
    };
  }
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
  if (MAX_TURNS_PATTERN.test(err)) {
    // Transient at classification time — `decideFault` promotes it to a deterministic park when the
    // body is unchanged since the last failed run (PD-406), since re-running the same oversized body
    // just re-hits the ceiling.
    return { tier: 'transient', signature: MAX_TURNS_SIGNATURE, reason: `reached the per-run turn limit: ${firstLine(err)}` };
  }
  return { tier: 'transient', signature: normalizeSignature(err), reason: `transient fault: ${firstLine(err)}` };
}

/** Exponential backoff for the Nth attempt (1-based), capped. */
export function backoffMs(attempt: number, policy: FaultPolicy): number {
  const step = policy.backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(step, policy.backoffMaxMs);
}

/** Failures that count against a ticket's budget — system-wide faults are excluded (zero burn), and
 *  so are session limits (PD-470): the account ran out of quota, which is not evidence of anything
 *  about this ticket. Excluding them here is ALSO what structurally prevents the deterministic
 *  promotion that stranded PD-420 for ~12h — two identical session-limit signatures are one
 *  transient cause seen twice, and neither one is ever counted. */
function countable(failures: FailedRun[]): FailedRun[] {
  return failures.filter((f) => f.tier !== 'system-wide' && f.signature !== SESSION_LIMIT_SIGNATURE);
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
  | { action: 'pause'; tier: FaultTier; signature: string; reason: string }
  /** PD-470: hold the WHOLE loop until `until`, then resume unattended. The ticket stays queued —
   *  a session limit is an account-wide condition, so parking this one ticket would be both wrong
   *  (it did nothing) and useless (the next ticket hits the same wall). */
  | { action: 'wait'; tier: FaultTier; signature: string; reason: string; until: number };

/** True when the ticket body CHANGED since its most recent countable failure (PD-406). A genuinely
 *  re-scoped ticket deserves a fresh transient attempt; an untouched one does not. No prior failure
 *  (nothing to compare) or a missing hash on either side ⇒ treat as UNCHANGED, so a max-turns fault
 *  parks rather than burning a futile retry. */
function bodyChangedSinceLastFailure(priorFailures: FailedRun[], currentBodyHash: string | null): boolean {
  const c = countable(priorFailures);
  if (c.length === 0) return false;
  const last = c.reduce((a, b) => ((b.finishedAt ?? 0) >= (a.finishedAt ?? 0) ? b : a));
  if (currentBodyHash == null || last.bodyHash == null) return false;
  return last.bodyHash !== currentBodyHash;
}

/**
 * Decide what to do after a FRESH failure, given the ticket's PRIOR failures.
 *   - system-wide  → pause the loop (this run does not count against the ticket).
 *   - deterministic→ park now (0 retries).
 *   - max-turns on an unchanged body (PD-406) → park now (deterministic) — a retry would re-hit the
 *     ceiling; only a body change since the last failed run earns the transient budget.
 *   - transient    → promote to deterministic-park if this signature has now repeated
 *                    `promoteAfter` times; else park if the cap is hit; else retry.
 * `currentBodyHash` is the hash of the body THIS run ran against (PD-406); omit for callers that
 * don't track it (the max-turns branch then treats the body as unchanged).
 */
export function decideFault(
  cls: FaultClassification,
  priorFailures: FailedRun[],
  policy: FaultPolicy,
  currentBodyHash: string | null = null,
  now: number = Date.now(),
): FaultDecision {
  if (cls.tier === 'system-wide') return { action: 'pause', ...cls };
  if (cls.tier === 'deterministic') return { action: 'park', ...cls };

  // PD-470: a session limit is a wait, not a failure. Decided before every counting rule below so
  // no repeat count, cap or promotion can reach it — the ticket keeps its budget and its place.
  if (cls.signature === SESSION_LIMIT_SIGNATURE) {
    const parsed = cls.resetAt ?? null;
    const until = parsed ?? now + SESSION_LIMIT_FALLBACK_MS;
    return {
      action: 'wait',
      tier: cls.tier,
      signature: cls.signature,
      reason: parsed
        ? `${cls.reason} — holding dispatch until the stated reset`
        : `${cls.reason} — reset time unreadable, holding dispatch for ${Math.round(SESSION_LIMIT_FALLBACK_MS / 60_000)}m`,
      until,
    };
  }

  // PD-406: a max-turns cutoff means the ticket is too big for one run. Handled in its own branch so
  // the same-signature promotion (`promoteAfter`) can't park a genuinely re-scoped retry.
  if (cls.signature === MAX_TURNS_SIGNATURE) {
    // Unchanged body ⇒ retrying just re-hits the wall (PD-377 run 7 burned ~1h) → park now.
    if (!bodyChangedSinceLastFailure(priorFailures, currentBodyHash)) {
      return {
        action: 'park',
        tier: 'deterministic',
        signature: cls.signature,
        reason: `max-turns on an unchanged body — parking without a futile retry (${cls.reason})`,
      };
    }
    // Body changed (scope trimmed) ⇒ a real new attempt; retry until the overall cap bounds an
    // endless edit loop.
    const total = countable(priorFailures).length + 1;
    if (total >= policy.retryCap) {
      return { action: 'park', tier: 'transient', signature: cls.signature, reason: `retry cap reached (${total}/${policy.retryCap}) — ${cls.reason}` };
    }
    return { action: 'retry', ...cls };
  }

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
