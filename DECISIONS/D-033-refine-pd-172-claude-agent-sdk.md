# D-033: "Refine" (PD-172) is a Claude-Agent-SDK sidecar with clone-grounded grilling and propose→approve write-back

**Decision:** The backlog→Ready "Refine" flow runs a **dedicated `refine-agent` sidecar container**
on the `egress_internal` network (mirroring Sortie), running the **Claude Agent SDK** with a
purpose-built refine prompt that reuses the `/grill-me` interview methodology — it does NOT run
`/to-issues`/`/to-sortie-issues` verbatim, since those target GitHub/tracker issues, not board
tickets. On Refine, the sidecar **shallow-clones the ticket's `github_repo` read-only** to ground the
grilling in real code (text-only fallback when `github_repo` is null). The chat streams to a modal
over **SSE** (agent→browser tokens) with a **POST per user turn**, both proxied by the dashboard
server. The agent's final output is a **structured Ready-ticket proposal**; the user edits/approves
in the modal, and the **dashboard server** (not the agent) creates the Ready tickets.

**Why:**

- **Agent SDK over a bespoke Messages-API loop or a one-shot call.** The interactive grill is the
  point of Refine; the Agent SDK provides the multi-turn tool-loop + skill execution a hand-rolled
  loop would reimplement, and a one-shot "format this ticket" call would drop the grilling entirely.
- **Sidecar over in-dashboard-server.** Isolates long-running interactive sessions + secrets
  (Anthropic key, GH token) from the Fastify web process, and reuses the containerized, egress-scoped
  pattern Sortie already established ([[D-016]]) under the egress-hardened networking of PD-7. Egress
  to `api.anthropic.com` goes through the existing squid proxy.
- **Propose→approve→server-writes over agent-writes-directly.** Keeps board-write credentials out of
  the agent (least privilege — the sidecar holds only a **read-only** GH token, for cloning), and
  bakes in a human gate structurally rather than trusting the agent to stop and ask.
- **Clone-grounded grilling.** Ungrounded refinement produces the vague, guessy tickets [[D-020]]'s
  pipeline exists to eliminate; Sortie already clones per-issue workspaces, so a read-only clone is a
  consistent, cheap way to ground ticket-slicing in real files.

**Trade-off:** A new sidecar + SSE plumbing + a clone-per-session is materially more infrastructure
than a one-shot API call — accepted because interactive, code-grounded refinement is the feature.
Session state is server-side and ephemeral: one Refine session at a time, discarded if the modal
closes before approval (no grill persistence in v1).

**Implications:** Requires an `ANTHROPIC_API_KEY` + a **read-only** GH token in the sidecar env only
(NAS `.env`, added to `.env.example`); never in the web process or browser. Depends on PD-7's
egress/networking outcome. Refine is offered on any backlog ticket; grounding degrades gracefully for
`github_repo`-null projects. See [[D-032]] for why the Claude-powered formatting lives here and not in
the Queued poller.
