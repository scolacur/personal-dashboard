# D-TMP-PD558a: A Robot asks the server for a decision id; it still cannot touch the board DB (PD-558; clarifies D-055, D-039)

**Decision:** The Robot's DB-blindness is **unchanged**. `dashboard.db` stays mode-600 and
unreadable to the coding uid, exactly as [[D-055]]'s privilege split established. Decision-id
allocation (PD-557) does not need and does not get an exception.

- A Robot that needs a `D-NNN` **POSTs to `/api/decisions/allocate`**. The **server** performs the
  increment inside a single atomic statement and returns the id. The Robot receives a number over
  HTTP; it never opens the database.
- **[[D-039]] is untouched.** It governs board *authority* — the ticket is the durable spec, and
  agent-created tickets are backlog-only so a Robot cannot queue or complete itself. Nothing here
  touches any of that.
- The rule to carry forward is therefore the same one that was already true: **a Robot may ask the
  server to do a thing; it may not do the thing to the database itself.**

**Why:**

- **The epic's framing invited an amendment that turned out to be unnecessary.** PD-556 proposed
  "semi-overturning D-039 so Robots may read the DB but never write it," with allocation as the
  motivating case. But allocation *cannot* be a read: two authors who both read "next = 86" both
  get 86, which is the precise collision the epic exists to remove. Once allocation is correctly
  modelled as a server-performed write reached over HTTP, the motivating case evaporates — and with
  it the reason to open the file. No other consumer was identified.
- **It would also have amended the wrong decision.** D-039 says nothing about DB reachability; the
  DB-blindness is D-055's uid split, which PROJECT.md §8 names as the **one genuine firewall** in
  the system — the only control whose unavoidability is enforced from outside the code, by a uid
  and a file mode, rather than by a function a caller could decline to call. Relaxing it via a
  decision that does not describe it is how a boundary gets weakened without anyone reviewing the
  boundary.
- **A permission with no consumer is the expensive kind of mistake.** Opening the file today costs
  nothing visible and is very hard to close later: anything built in the meantime may quietly come
  to depend on direct reads, and the next author finds a firewall that is already porous and treats
  that as the baseline. The asymmetry is the whole argument — keeping it shut is reversible the
  moment a real read case appears, and opening it is not.
- **This is written down because the misreading is predictable.** "Robots can talk to the DB now"
  is exactly the sentence a future agent will take from the epic's framing, and PD-558's own body
  anticipated it. A decision that says *we considered this and deliberately did not do it* is worth
  more here than silence, which reads as an oversight and invites someone to implement it.

**Trade-off:** A genuine future read case — one that is a read, not a disguised write — will have to
re-open this rather than finding the door already unlocked. Accepted: that re-opening is a
conversation about a specific need, with a named consumer, which is the conversation that should
happen before a firewall moves. The cost is one extra round trip of design work at some later date;
the thing bought is that the boundary only ever moves on purpose.

**Implications:**

- PD-558's original title — "Robots may read the board DB, but still never write it (amends D-039)"
  — is retired; the ticket is retitled to match this decision. No ops change, no file-mode change,
  no `AGENT_UID` change.
- The pattern generalises beyond decision ids: when a Robot needs something only the database can
  answer, the shape is **an endpoint on the server**, not a widened uid. That keeps the server as
  the single place where board access is reviewed, and keeps [[D-055]]'s firewall a firewall rather
  than middleware (PROJECT.md §8 draws that distinction — a control a caller can decline to use is
  not a boundary).
- Applies to the rest of PD-556: PD-559 (authoring writes a real `D-NNN`) instructs authors to call
  the endpoint, and PD-560 (cutover) numbers the inbox by allocating from the same counter, so
  there remains exactly one allocator and no direct DB access anywhere in the flow.
