# Buy, Sell, Trade — Widget PROJECT.md

Works both sides of Steve's gear trading: it watches r/modular's monthly Buy/Sell/Trade thread
for anyone mentioning gear on his list, and drafts his own monthly post from that same list.

The list is **gear**, not modules — Eurorack is simply what he has most of today.

Epic: **PD-436**. This doc covers the widget as a whole; slices land incrementally.

---

## 1. Scope

| Slice | Ticket | State |
| ----- | ------ | ----- |
| A — page, widget shell, gear list CRUD, sale terms, CSV import | PD-437 | **built** |
| B — matcher + matches readout | PD-438 | **built** |
| B2 — thread discovery + scheduled scan (needs Reddit API approval) | PD-471 | client built; blocked on approval |
| C — monthly draft-post job (Reddit + Facebook) | PD-439 | not started |
| D — run history in the expanded view | PD-440 | not started |

---

## 2. Data model

Tables are namespaced `buy_sell_trade_*`; times are unix ms integers (root PROJECT.md §5).

**`buy_sell_trade_listings`** — the gear list, imported once from a Google Sheet and maintained
in-app thereafter. **It is gear, not modules** (hence `item`): Eurorack is just what Steve has
most of today, and drum machines, synths and pedals live on the same list.

| Column | Notes |
| ------ | ----- |
| `type` | `WTB` \| `WTS`. **`WTT` was retired** (D-065) — "want to trade for" is a want, so those rows are WTB. The *commenter* side keeps WTT; see `BstMatchIntent`. |
| `manufacturer` | nullable |
| `item` | **required** — what the scanner matches comments against |
| `price` | **TEXT, not a number** — see below |
| `sale_status` | `for-sale` \| `feelers` \| `probably-wont-sell`. `null` on WTB rows. |
| `category` | `Modules` \| `Other Instruments` \| `Misc`. `null` on WTB rows. |
| `condition` | nullable |
| `notes` | **public** — goes in the drafted post ("og box", "purchased new") |
| `private_notes`, `location` | **private** — shown to Steve when drafting so he can find the thing; never in the post |

**There is no uniqueness constraint, deliberately.** PD-437 shipped
`UNIQUE (type, manufacturer, module)` and it was wrong about the domain: Steve owns two of some
items, in different condition, at different prices, and each is a listing. Duplication is a
question the UI asks — `POST /listings` returns `409 DUPLICATE_CONFIRM` with the existing rows,
and re-sending with `confirmDuplicate: true` goes through (D-065).

**`buy_sell_trade_matches`** — one comment that mentioned one listing (PD-438).
`UNIQUE (listing_id, comment_id)` plus `INSERT … ON CONFLICT DO NOTHING` is what makes re-scanning
a thread a no-op — including for matches already dismissed, which must **not** come back to life
with a null `dismissed_at`. `ON DELETE CASCADE` from the listing, because an orphan match has
nothing to display.

**`buy_sell_trade_settings`** — single row (`CHECK (id = 1)`) holding the standing sale terms
appended to drafted posts.

### The taxonomy

Two independent axes, split out of the sheet's single section column:

- **Sale status** (willingness): For Sale → Feelers → Probably Won't Sell.
  **Only `for-sale` is drafted as a firm sale** by PD-439 (`isFirmSale`).
- **Category**: Modules, Other Instruments, or Misc, within each status.

### Why `price` is text

A real gear list carries "$250 shipped", "offers", "trade only" as often as a bare figure. The
real import bore this out: of 44 item rows, 29 had a price, 3 said `TBD`, 12 were blank. A
numeric column would have destroyed all 15 non-numeric cells. The cost is lexical sorting.

---

## 3. CSV import

`POST /api/widgets/buy-sell-trade/listings/import` takes pasted CSV text.

**The source sheet is not a flat table.** The first version of this importer assumed it was and
rejected all 46 rows. Its real shape:

| Column | Contents |
| ------ | -------- |
| 1 (titled with the list's name) | Free prose: the **sale terms**, then a `WTTF:` marker, then a **want-list** |
| 2 ("Type") | A **section marker** applying *downward* — `MODULES` / `MISC` / `Feelers` / `Probably won't sell` — **not** WTB/WTS/WTT |
| 3+ | Manufacturer, Module, Price, Condition, Notes, Current Location |

`Module`, `Item` and `Gear` all map to the `item` field, so an old export and a future one both
import.

One row can carry a terms line, a section change and a listing simultaneously; each is extracted
independently.

Handling:

- An item row with no explicit type is **WTS** — the sheet is a *For Sale* list.
- Section markers are split into `sale_status` + `category`. A willingness marker
  (`Feelers`) **resets category to `Modules`** rather than carrying the previous one forward,
  which would mislabel 22 items `Misc` because one `MISC` row happened to precede them.
- Want-list entries below `WTTF:` import as `WTB` with only a name, and no sale status
  or category — Steve is not the one offering them. `Non-modular` and other sub-headings are
  skipped via an explicit list, not a heuristic.
- Sale terms above the `WTTF:` marker are **offered, never applied** — returned as
  `extractedTerms` for the UI to show with a "use these" action, so a re-import cannot clobber
  terms edited in the app.
- Headers match case-insensitively, whitespace-tolerantly, and **with a trailing parenthetical
  stripped** — the sheet's column is literally `Current Location (For my personal reference)`,
  so an exact match would silently import every location as empty.
- **Mojibake is repaired** (`repairMojibake`): the export mis-encodes Cyrillic item names as
  UTF-8-read-as-Latin-1. Not cosmetic — PD-438 matches on the item name, so a mangled name
  can never match a comment. Guarded to touch only strings with a mojibake signature that then
  decode cleanly.
- An unrecognised section marker is **reported**, not ignored, since everything below it
  silently inherits the previous status.
- Runs in a transaction, so a bad paste leaves the list exactly as it was.

The parser is hand-rolled (`csv.ts`) rather than a dependency: it parses one known export, and
the only non-trivial part it needs is quoted fields, since Notes contains commas.

### What the real sheet produced

58 rows from 56 lines: 44 WTS + 14 wants, 0 skipped. By sale status: 14 for-sale, 22 feelers,
8 probably-won't-sell, 14 n/a (wants). Re-import updates rather than duplicating — the key is now
`(type, manufacturer, item, condition)`, so two of the same thing in different condition stay two
rows. **Two sheet rows identical in all four fields collapse to one**; that is the stated cost of
keeping re-paste idempotent without a uniqueness constraint (D-065).

---

## 4. API

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/api/widgets/buy-sell-trade/listings` | List |
| POST | `/api/widgets/buy-sell-trade/listings` | Create. **409 `DUPLICATE_CONFIRM`** with the existing rows unless `confirmDuplicate: true` |
| PATCH | `/api/widgets/buy-sell-trade/listings/:id` | Partial update; omitted field = unchanged, explicit `null` = clear. Same 409, only when the edit moves the row onto another's identity |
| DELETE | `/api/widgets/buy-sell-trade/listings/:id` | Delete (cascades to its matches) |
| POST | `/api/widgets/buy-sell-trade/listings/import` | CSV import |
| GET | `/api/widgets/buy-sell-trade/matches` | Open matches; `?includeDismissed=true` for all |
| GET | `/api/widgets/buy-sell-trade/matches/count` | `{ open: n }` for the collapsed card |
| PATCH | `/api/widgets/buy-sell-trade/matches/:id` | `{ dismissed: boolean }` |
| POST | `/api/widgets/buy-sell-trade/matches/ingest` | `{ threadId, comments[] }` — **the seam** (below) |
| GET/PUT | `/api/widgets/buy-sell-trade/settings` | Sale terms |

### The matcher (PD-438)

`matcher.ts` takes `{ id, author, body, permalink }` and nothing else — **it does not know Reddit
exists**. That keeps it testable against fixtures and makes a hand-pasted thread a working
fallback while API access is pending, via `POST /matches/ingest`.

**It is tuned for precision, not recall, and that is not a preference — it follows from the
schedule.** The scan runs weekly and Steve reads the output, so a false match costs him attention
every week while a miss costs one trade. Concretely:

- Matching is on **whole tokens**, never substrings, after normalising case, punctuation and
  apostrophes ("Pam's" → `pams`). Cyrillic is lowercased, never transliterated.
- A **generic** name — ordinary modular vocabulary (`Mix`, `VCA`, `Loop`, `Slice`) or anything
  under 4 characters — only matches when the **manufacturer appears within ~40 characters** of it.
  "2hp Mix" matches; "Doepfer A-138 mix" does not. A generic name on a listing with **no
  manufacturer cannot match at all**.
- `GENERIC_TERMS` is **safe to grow, unsafe to shrink**: an entry only ever costs recall on
  listings with no manufacturer recorded.
- Aliases (`MODULE_ALIASES`) are curated and therefore trusted even when short — `ppw` matches
  where a 3-character *item name* would not.
- **Intent is positional.** One comment routinely carries both `WTS:` and `WTB:` sections, so
  intent comes from the nearest marker *before* the mention, and is `unknown` when there isn't
  one. `unknown` is a first-class outcome, not a failure.
- A hit on a **WTB row** where the commenter is selling is marked `high` significance and sorted
  first (`matchSignificance`) — someone offering gear Steve wants is the payoff of the whole
  feature and is easy to bury under sale-side noise.

---

## 5. Frontend

- **Collapsed card** (`lib/BuySellTrade.svelte`): counts by type, the open-match count, plus a
  few item names. Per
  D-062 the card header links to the page rather than flipping.
- **Expanded view** (`routes/widgets/buy-sell-trade/+page.svelte`): the matches readout
  (grouped by item, significance first, with comment + profile links and a dismiss action), the
  gear list via the generic **`ListManager`** (PD-441) — no bespoke list — plus collapsible
  CSV-import and sale-terms sections, and the duplicate-confirmation modal.

---

## 6. Configuration

The gear list, CSV import, sale terms and the matcher all need **none** — the matcher is fed
comments, it does not fetch them. Reddit credentials (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` /
`REDDIT_REFRESH_TOKEN` or `REDDIT_USERNAME`+`REDDIT_PASSWORD` / `REDDIT_USER_AGENT` /
`BST_SUBREDDIT`) belong to the fetch half (PD-471) and must no-op with one log line when absent.
See `.env.example`.

---

## 7. Open questions

- Should `Misc` be applied to more rows? The import defaults everything under a willingness
  marker to `Modules`; the cases and the EHX pedal are arguably Misc.
- Should a sold item be archived rather than deleted, to keep price history?
