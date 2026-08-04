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
| `type` | `WTB` \| `WTS` \| `WTT` |
| `manufacturer` | nullable |
| `module` | **required** — what the scanner matches comments against |
| `price` | **TEXT, not a number** — see below |
| `condition`, `notes`, `location` | nullable; `location` is Steve's own reference and is never posted |

`UNIQUE (type, manufacturer, module)` **COLLATE NOCASE** — this is what makes the CSV import
idempotent, and the case-insensitivity is deliberate: "Maths" and "maths" are the same listing,
and a case-sensitive key would silently double it on re-import.

**`buy_sell_trade_settings`** — single row (`CHECK (id = 1)`) holding the standing sale terms
appended to drafted posts.

### Why `price` is text

A real gear list carries "$250 shipped", "offers", "trade only" as often as a bare figure, and
the import must not lose that. The cost is that sorting by price is lexical. If the imported
sheet turns out to be consistently numeric, this is worth revisiting.

---

## 3. CSV import

`POST /api/widgets/buy-sell-trade/listings/import` takes pasted CSV text.

- Headers are matched case-insensitively, whitespace-tolerantly, and **with a trailing
  parenthetical stripped** — the source sheet's column is literally
  `Current Location (For my personal reference)`, so an exact match would drop it silently.
- Unrecognised columns are ignored: the sheet's first column is a list title, not a field.
- A row with no `Module`, or an unrecognised `Type`, is **skipped and reported** — never
  guessed. Both fields are load-bearing downstream.
- Runs in a transaction, so a bad paste leaves the list exactly as it was.

The parser is hand-rolled (`csv.ts`) rather than a dependency: it parses one known export, and
the only non-trivial part it needs is quoted fields, since Notes contains commas and newlines.

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

- Does the real sheet's Price column justify a numeric type after all?
- Should a sold item be archived rather than deleted, to keep price history?
