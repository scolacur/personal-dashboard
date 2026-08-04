# Buy, Sell, Trade — Widget PROJECT.md

Works both sides of modular gear trading: it watches r/modular's monthly Buy/Sell/Trade thread
for anyone mentioning gear on Steve's list, and drafts his own monthly post from that same list.

Epic: **PD-436**. This doc covers the widget as a whole; slices land incrementally.

---

## 1. Scope

| Slice | Ticket | State |
| ----- | ------ | ----- |
| A — page, widget shell, gear list CRUD, sale terms, CSV import | PD-437 | **built** |
| B — weekly r/modular scan + matcher + matches readout | PD-438 | not started |
| C — monthly draft-post job (Reddit + Facebook) | PD-439 | not started |
| D — run history in the expanded view | PD-440 | not started |

---

## 2. Data model

Tables are namespaced `buy_sell_trade_*`; times are unix ms integers (root PROJECT.md §5).

**`buy_sell_trade_listings`** — the WTB/WTS/WTT list, imported once from a Google Sheet and
maintained in-app thereafter.

| Column | Notes |
| ------ | ----- |
| `type` | `WTB` \| `WTS` \| `WTT`. **`WTT` means "want to trade FOR"** — gear Steve would accept, not gear he offers. `isSellable` is therefore WTS-only. |
| `manufacturer` | nullable |
| `module` | **required** — what the scanner matches comments against |
| `price` | **TEXT, not a number** — see below |
| `sale_status` | `for-sale` \| `feelers` \| `probably-wont-sell`. `null` on want rows. |
| `category` | `Modules` \| `Misc`. `null` on want rows. |
| `condition`, `notes`, `location` | nullable; `location` is Steve's own reference and is never posted |

`UNIQUE (type, manufacturer, module)` **COLLATE NOCASE** — this is what makes the CSV import
idempotent, and the case-insensitivity is deliberate: "Maths" and "maths" are the same listing,
and a case-sensitive key would silently double it on re-import.

**`buy_sell_trade_settings`** — single row (`CHECK (id = 1)`) holding the standing sale terms
appended to drafted posts.

### The taxonomy

Two independent axes, split out of the sheet's single section column:

- **Sale status** (willingness): For Sale → Feelers → Probably Won't Sell.
  **Only `for-sale` is drafted as a firm sale** by PD-439 (`isFirmSale`).
- **Category**: Modules or Misc, within each status.

### Why `price` is text

A real gear list carries "$250 shipped", "offers", "trade only" as often as a bare figure. The
real import bore this out: of 44 module rows, 29 had a price, 3 said `TBD`, 12 were blank. A
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

One row can carry a terms line, a section change and a listing simultaneously; each is extracted
independently.

Handling:

- A module row with no explicit type is **WTS** — the sheet is a *For Sale* list.
- Section markers are split into `sale_status` + `category`. A willingness marker
  (`Feelers`) **resets category to `Modules`** rather than carrying the previous one forward,
  which would mislabel 22 modules `Misc` because one `MISC` row happened to precede them.
- Want-list entries below `WTTF:` import as `WTT` with only a module name, and no sale status
  or category — Steve is not the one offering them. `Non-modular` and other sub-headings are
  skipped via an explicit list, not a heuristic.
- Sale terms above the `WTTF:` marker are **offered, never applied** — returned as
  `extractedTerms` for the UI to show with a "use these" action, so a re-import cannot clobber
  terms edited in the app.
- Headers match case-insensitively, whitespace-tolerantly, and **with a trailing parenthetical
  stripped** — the sheet's column is literally `Current Location (For my personal reference)`,
  so an exact match would silently import every location as empty.
- **Mojibake is repaired** (`repairMojibake`): the export mis-encodes Cyrillic module names as
  UTF-8-read-as-Latin-1. Not cosmetic — PD-438 matches on the module name, so a mangled name
  can never match a comment. Guarded to touch only strings with a mojibake signature that then
  decode cleanly.
- An unrecognised section marker is **reported**, not ignored, since everything below it
  silently inherits the previous status.
- Runs in a transaction, so a bad paste leaves the list exactly as it was.

The parser is hand-rolled (`csv.ts`) rather than a dependency: it parses one known export, and
the only non-trivial part it needs is quoted fields, since Notes contains commas.

### What the real sheet produced

58 rows from 56 lines: 44 WTS + 14 WTT, 0 skipped. By sale status: 14 for-sale, 22 feelers,
8 probably-won't-sell, 14 n/a (wants). Re-import updates all 58 rather than duplicating.

---

## 4. API

| Method | Route | Purpose |
| ------ | ----- | ------- |
| GET | `/api/widgets/buy-sell-trade/listings` | List |
| POST | `/api/widgets/buy-sell-trade/listings` | Create (409 on duplicate identity) |
| PATCH | `/api/widgets/buy-sell-trade/listings/:id` | Partial update; omitted field = unchanged, explicit `null` = clear |
| DELETE | `/api/widgets/buy-sell-trade/listings/:id` | Delete |
| POST | `/api/widgets/buy-sell-trade/listings/import` | CSV import |
| GET/PUT | `/api/widgets/buy-sell-trade/settings` | Sale terms |

---

## 5. Frontend

- **Collapsed card** (`lib/BuySellTrade.svelte`): counts by type plus a few module names. Per
  D-062 the card header links to the page rather than flipping.
- **Expanded view** (`routes/widgets/buy-sell-trade/+page.svelte`): the gear list via the
  generic **`ListManager`** (PD-441) — no bespoke list — plus collapsible CSV-import and
  sale-terms sections.

---

## 6. Configuration

Slice A needs none. Slice B (PD-438) will add Reddit script-app credentials —
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USERNAME` / `REDDIT_PASSWORD` /
`REDDIT_USER_AGENT` / `BST_SUBREDDIT` — and must no-op with one log line when they are absent.

---

## 7. Open questions

- Should `Misc` be applied to more rows? The import defaults everything under a willingness
  marker to `Modules`; the cases and the EHX pedal are arguably Misc.
- Should a sold item be archived rather than deleted, to keep price history?
