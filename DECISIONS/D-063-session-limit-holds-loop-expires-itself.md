# D-063: A session limit holds the loop and expires itself; it never parks a ticket

**Decision:** A provider session/usage limit is its own fault class (`session-limit` signature),
handled as a **loop-wide, self-expiring hold** (`robot_state.session_limit_until`) rather than a
per-ticket park. The ticket that hit the limit goes straight back to `queued`, its run is recorded
but excluded from the retry budget, and the cycle stops. The next cycle after the stated reset time
clears the hold and dispatches normally — with no human action. Shipped in PD-470; deliberately
**not** the per-ticket park-with-wake-time that PD-470's body originally specified.

**Reasoning:**

- **A session limit is a property of the account, not the ticket.** Parking the one ticket that
  happened to be running when the quota ran out blames it for something it did not do, and leaves
  every other queued ticket to hit the same wall and collect the same meaningless failed run. One
  hold covers the whole board.
- **The old behaviour was a park that outlived its cause.** On 2026-07-28 the limit hit at ~21:45,
  quota reset at 1:30 AM, and the ticket sat parked until the afternoon — ~12h — with four tickets
  stranded behind it. The reset time is *in the error text*, so nothing needed to be waited on.
- **It must not promote to deterministic.** C2 promotes an identical signature at N=2, which is what
  parked it. Excluding the signature from `countable()` kills the promotion structurally rather than
  special-casing the promotion rule, so cap, backoff and promotion all skip it by construction.
- **Kept separate from `dispatch_paused` on purpose.** A pause waits for a human and must survive a
  restart (D-055 / the PD-320 failure mode: auto-resuming an auth outage re-burns the board); a hold
  ends by itself at a known time. Collapsing them would force one of the two to behave wrongly.
- **Unparseable degrades, never stalls.** The provider's phrasing is not a contract, so an unreadable
  reset time falls back to a bounded 15-minute hold, and a parse landing more than 12h out is
  discarded as a mis-parse rather than trusted.
