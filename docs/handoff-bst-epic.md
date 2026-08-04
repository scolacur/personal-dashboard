# Handoff — Buy/Sell/Trade epic (PD-436)

For an agent picking up the BST epic cold. Written 2026-08-04, after slices A and the Reddit
client shipped.

**Read first:** `widgets/buy-sell-trade/PROJECT.md`. It is current and detailed; this doc covers
what that file can't — state, traps, and judgment calls that aren't in the code.

---

## 1. What this epic is

A `/buy-sell-trade` page with one widget working both sides of Steve's modular gear trading:

- **Inbound** — weekly scan of r/modular's monthly Buy/Sell/Trade thread for comments mentioning
  gear on his list, surfacing module + who + intent + links.
- **Outbound** — a monthly job (~the 15th) drafting his own BST post in Reddit and Facebook
  formats, with his standing terms.

## 2. State

| Ticket | State | Notes |
|---|---|---|
| **PD-437** — page, widget, gear list, CSV import, terms | ✅ merged (#284) | 58 listings imported and live |
| **PD-441** — generic `ListManager` | ✅ merged (#278) | BST is its first consumer |
| **PD-471** — read-only Reddit client | PR **#287**, open | Built ahead of need; see §5 |
| **PD-438** — matcher + matches readout | **→ start here** | Unblocked, no credentials needed |
| **PD-439** — monthly draft-post job | Ready | Unblocked |
| **PD-440** — run history in the widget | Blocked | by PD-471 + PD-442 |
| **PD-442** — generic job-runs component | Ready | Not part of this epic, but PD-440 needs it |

**Robot dispatch is paused** (manual hold, token budget). These have been shipped by hand, and
tickets marked `completed` manually — the loop won't do it for you.

## 3. Domain facts you will not guess

Steve's list is **imported and live** — 58 rows. Do not re-derive any of this from the CSV.

- **`WTT` means "want to trade FOR"** — gear Steve would *accept*, not gear he offers.
  `isSellable()` is **WTS-only**. Getting this backwards drafts his want-list into the for-sale
  table, which is exactly the bug that nearly shipped.
- **Two independent axes**, invented rather than mirroring the sheet:
  `sale_status` (`for-sale` / `feelers` / `probably-wont-sell`) × `category` (`Modules` / `Misc`).
  **Only `for-sale` is a firm sale** — use `isFirmSale()`.
- The split matters more than it looks: of 44 for-sale-side rows, **22 are `feelers`** and 8 are
  `probably-wont-sell`. **Just 14 are firm.** A drafter that posts all 44 is wrong.
- `price` is **TEXT, not a number** — "$250 shipped", "TBD", "offers", and 15 blanks are real. It
  sorts lexically; that was a deliberate trade.
- `location` is Steve's own reference (`Rack A`, `Box 2`). **Never put it in a drafted post.**

## 4. Start here — PD-438 (matcher)

Buildable today with no Reddit access. The seam is a plain comment shape
(`{ id, author, body, permalink, createdUtc, score }`), so the matcher never knows where comments
came from — test it against fixtures, and a manual paste stays a usable fallback.

**The hard part is precision, not matching.** Steve's list contains module names that are ordinary
modular vocabulary: `Mix`, `VCA`, `Loop (Silver)`, `Slice`, `Qua`, `MIX`, `Where?`, `Helium`. A
naive substring match flags every comment containing the word "mix". A false match costs Steve
attention *every week*; a miss costs one trade. **Tune for precision, and say so in the tests.**

Suggested approach: require word-boundary matches; for short or generic names require the
manufacturer to corroborate ("2hp Mix", not bare "mix"); support aliases and possessives
("Pamela's PRO Workout" / "Pam's" / "PPW"). Record intent as `unknown` rather than guessing.

Worth remembering: a hit on a **WTT want** means someone is *selling what he wants* — arguably the
most valuable signal in the whole feature, not an afterthought.

## 5. External blockers — Reddit

**Steve is mid-application.** As of 2026 Reddit gates new API credentials behind a manual approval
form (Responsible Builder Policy); small personal projects are sometimes rejected. This is why
PD-438 was split from PD-471 — so the valuable half isn't hostage to it.

- **The client is written and read-only by construction.** `assertReadOnlyEndpoint` rejects any
  non-GET except `/api/v1/access_token` and `/api/morechildren`. **Do not weaken this** — it is
  the guarantee the API application makes to Reddit in writing.
- **Unresolved: does Steve's account have 2FA?** If yes, the password grant is dead (rotating OTP)
  and he needs `REDDIT_REFRESH_TOKEN`. The client supports both and prefers the refresh token.
- With credentials unset the widget **no-ops with one log line** — never make that throw.

## 6. Traps this session actually hit

1. **The spec can be wrong about the data.** PD-437's importer, written exactly to its ticket,
   rejected **all 46 rows** of the real sheet. It was diagnosable in one run only because it
   *reported per-row reasons instead of silently importing nothing*. Keep that property.
2. **Check the column, not the JSON.** `agent_tickets.priority` stores unset as the string
   `'none'`, never SQL NULL; the API maps it to `null` only at the boundary. A `IS NULL` check was
   dead code against a third of the board. Read `schema.ts`.
3. **A component with no callers is not verified.** `ListManager` shipped green and was *unusable* —
   `ListItem = Record<string, unknown>` rejects TS interfaces, and every domain type here is an
   interface. Found only when PD-437 tried to use it.
4. **`vitest` does not typecheck.** A green spec file proves little; `npm run verify` runs `tsc`,
   which is what catches missing fields on shared types. There are also **two separate board
   fixtures** (`select.spec.ts`, `robot.spec.ts`) — adding a column means touching both, and the
   second fails at runtime with `no such column`, not at compile time.
5. **The board moves under you.** Several sessions run in parallel; `main` moved three times
   mid-branch today. Re-query the board rather than reciting a remembered lane, and rebase before
   opening a PR.
6. **Memory committed on a feature branch is not memory** — a squash merge can drop it. Commit
   `MEMORY/` straight to `main`.
7. Real exports carry **mojibake** (UTF-8 read as Latin-1) and **parenthetical headers**
   (`Current Location (For my personal reference)`). Both are handled in `csv.ts`; both would
   otherwise fail silently rather than loudly.

## 7. Conventions that apply here

- Work in a git worktree under `.claude/worktrees/`; `npm install` in it (a worktree without its
  own install 403s the client entry under `vite dev`).
- `npm run verify` must be `EXIT=0` before a PR — build, typecheck, lint, test.
- Styles in sibling `.scss` files using the tokens in `global.scss`; no inline styles, no raw hex.
- Anything imported by a `.spec.ts` in `apps/web` **must not reach a `.svelte` file** — vitest runs
  there without the SvelteKit plugin.
- New user-managed lists use **`ListManager`** (PD-441). Do not hand-roll another list.

## 8. Files

```
packages/shared/src/buy-sell-trade.ts          types, taxonomy, isSellable / isFirmSale
apps/server/src/widgets/buy-sell-trade/
  schema.ts      tables + the NOCASE identity index that makes import idempotent
  csv.ts         sheet-shaped importer, mojibake repair, header mapping
  store.ts       CRUD + import + settings
  routes.ts      /api/widgets/buy-sell-trade/*
  reddit.ts      read-only client (PD-471, PR #287)
apps/web/src/lib/BuySellTrade.svelte           collapsed summary card
apps/web/src/lib/buy-sell-trade/api.ts         typed fetch wrappers
apps/web/src/routes/widgets/buy-sell-trade/    expanded view (ListManager + import + terms)
apps/web/src/lib/ListManager.svelte            generic CRUD list (PD-441)
widgets/buy-sell-trade/PROJECT.md              the spec — read it
```

## 9. Owed by Steve

- Submit the Reddit API access request (answers drafted; the decisive field is "what is missing
  from Devvit" — he doesn't moderate r/modular and the app has no Reddit-facing surface).
- Answer the 2FA question.
- Merge PR #287.
- Install or pause the queued macOS update — left alone on a tight disk it can take a fresh APFS
  snapshot and restart the disk-full cycle that cost this session several hours.
