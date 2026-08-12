# D-072: A GitHub rate limit holds dispatch; only a broken credential pauses it (PD-248)

**Decision:** GitHub throttles are classified as a **wait**, not an auth fault. `faults.ts` matches
GitHub's throttle *phrasing* before the auth/credit patterns and emits `action: 'wait'` with a reset
time, so the loop **holds** — ticket stays queued, budget untouched, resumes unattended — exactly as
a provider session limit does ([[D-063]]/PD-470). The existing hold gains a `kind`
(`session-limit` | `github-rate-limit`) so the dashboard names which. Headroom comes from a periodic
`gh api rate_limit` **probe**, not response headers, published on `SystemStatus`.

**Reasoning:**

- **A 403 meant two completely different things and we only handled one.** `SYSTEM_WIDE_PATTERNS`
  matched a bare `403`, and GitHub returns 403 for *both* a throttle and a bad credential. So the
  most routine condition in the system — being rate-limited — took the entire loop down and waited
  for a human, which is the loudest possible response to something that fixes itself in 60 seconds.
  PD-320/#202 is why the auth tier is aggressive; this narrows it to what it was actually aimed at.
- **Phrase-matched, never status-code-matched.** `rate limit exceeded`, `secondary rate limit`,
  `too many requests`, `was submitted too quickly`, `retry-after`. Widening to `\b40[39]\b` would
  swallow `403: Bad credentials` and `403: Resource not accessible by integration` — permission
  faults that no amount of waiting fixes, and that MUST keep pausing the loop. There are tests on
  both sides of that line precisely because the tempting simplification breaks the second one.
- **Never counted against the ticket.** A throttle joins the session limit in `HOLD_SIGNATURES`, so
  no repeat count, cap or deterministic promotion can reach it. Without this, three throttles would
  promote to a deterministic park and strand a ticket for a condition it had nothing to do with —
  the PD-420 failure mode, arrived at by a different road.
- **A probe, not response headers, because there are no headers to read.** Every GitHub call the
  loop makes goes through the `gh` CLI, and `gh pr view` surfaces no `x-ratelimit-*` at all. Reading
  headers would mean rewriting every call site against `gh api --include` and parsing raw HTTP. One
  call to `/rate_limit` answers the same question and is documented as not counting against the
  limit itself.
- **The probe runs even when dispatch is disarmed.** It starts before every dispatch gate in
  `startRobotJob`. Headroom matters most while deciding whether it is safe to turn the loop on
  (PD-468); a dashboard that only reports API health once the loop is already running cannot inform
  that decision.
- **A failed probe leaves the last reading in place rather than clearing it.** Its `checkedAt` then
  ages past `RATE_LIMIT_STALE_MS` and the UI reports **stale**. Writing null would be
  indistinguishable from "never probed", and those want different responses. `stale` outranks the
  numbers for the same reason: a comfortable "4,900 remaining" from an hour ago is worse than no
  number, because it reads as reassurance.
- **The hold carries a `kind` because the two holds are not the same news.** Both end by themselves
  and neither needs a human, but a spent Anthropic quota is purely a wait, while GitHub throttling
  the loop means something is hammering the API and is worth investigating. A UI that says "session
  limit" for the second sends you to the wrong place. Rows written before this carry no `kind` and
  every one of them *was* a session limit, so the default is not a guess.
- **`kind` was added to the existing hold rather than adding a second hold.** A parallel
  `github_rate_limit_until` key would mean two gates to check, two things for the UI to reconcile,
  and a new way for them to disagree. They are the same mechanism — wait until a stated time, then
  self-clear — differing only in cause.

**Implications:** `SystemStatus` gains `githubRateLimit`; the nav killswitch and the Dev Ops status
line both name the hold kind. The worst bucket wins when core and graphql disagree — headroom in one
quota is no comfort when the other is spent.

**Revisit if:** the loop ever stops going through the `gh` CLI. Direct HTTP would make response
headers readable at each call site, which is strictly better data than a probe every 5 minutes, and
this decision's main constraint would be gone.
