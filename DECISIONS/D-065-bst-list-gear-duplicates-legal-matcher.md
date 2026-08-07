# D-065: The BST list is gear, duplicates are legal, and the matcher is tuned for precision

> **Amended 2026-08-05 (PD-475) — point 5 is reversed: the matcher is tuned for RECALL.** Read the
> amendment below before the original reasoning; the "precision over recall" bullet and its
> justification no longer describe the system. Points 1–4 are unchanged.

**Amendment (2026-08-05, PD-475 — recall outranks precision, and nothing is discarded):**

Steve reversed the premise the evening D-065 shipped: *"I'd rather spend 2 seconds of attention vs
lose out on potentially a lot of money."*

**What is invalidated is the reasoning, not just the constants.** D-065 argued that precision
*follows from the schedule* — weekly output, so a false match costs attention every week while a
miss costs one trade — and presented that as arithmetic. It is not arithmetic; it is a claim about
whose time is worth what, and the person whose attention is being spent is the authority on it. He
priced a missed trade far above a weekly two-second skim. That settles it.

- **The change that implements it is "never discard", not "widen the threshold".** A match now
  carries a **confidence** (`confirmed` | `possible`); a mention the matcher cannot vouch for is
  *recorded* as `possible` and shown in a separate collapsed group. Widening thresholds alone would
  have kept throwing away the cases that motivated the reversal — a generic name on a listing with
  no manufacturer produced literal silence, indistinguishable from "nobody is selling one".
- **Named `confirmed`/`possible`, not PD-475's literal `high`/`low`.** A match already carries
  `BstMatchSignificance` (`high`/`normal`/`low`), and two fields on one record both reading "high"
  and meaning different things — *how sure* versus *how much it is worth your attention* — is a bug
  waiting to be written.
- **Corroboration is now the line item, not ±40 characters.** "Does the manufacturer appear in the
  same line item" is the real question, and it is both looser and more accurate than a character
  count — ±40 could not reach the far end of `Doepfer A-111-5 Mini Synth Voice — $90`. A 120-char
  backstop remains for the comment written as one unbroken paragraph, where "the same line" is the
  whole thing. The split is newlines and bullets only: **not** `|` (that is a markdown table's
  column separator, so splitting on it would punish the best-formatted comments) and **not** commas.
- **Aliases moved out of the code and partly into derivation.** A per-listing `aliases` field
  (merged with the curated defaults, not replacing them) exists because a hard-coded table cannot
  know that Steve's `A-111-5 Mini Synth Voice` is called "A-111-5", and does not scale to 52 rows.
  Machine-derived forms — leading model number, name minus a category tail or a `with …` clause,
  name minus a repeated manufacturer, and punctuation-dropped spellings like `A111-5` — are
  `possible` by construction, since each is a guess.
- **The cost is stated rather than hidden:** generic names now fire on nearly every comment in a
  thread, so the `possible` group is expected to be long. If it proves unreadable, the lever is
  `GENERIC_TERMS` and a floor on what is recorded at all — **not** a return to suppression, which is
  the thing being rejected here.

**`GENERIC_TERMS` changes character:** under D-065 an entry could suppress a listing entirely, so
growth was safe and shrinkage was not. It now only ever moves a hit between groups, which makes
adding to it cheaper than it was.

**Revisit if:** the `possible` group is long enough that Steve stops opening it — that is the
failure mode this trade buys, and it is the signal to add a recording floor rather than to
re-suppress. Fuzzy/edit-distance matching stays deliberately out (its own ticket, its own
evidence): it fails in ways these rules do not.

---

**Decision:** Four changes to the Buy/Sell/Trade model PD-437 shipped, plus the rule the PD-438
matcher is built on. Landed together because the matcher forced the model questions.

1. **The list is gear, not modules.** The field is `item`, not `module`, and `Other Instruments`
   joins `Modules` / `Misc` as a category. Eurorack is simply what Steve has most of today.
2. **`WTT` is retired as a listing *type*.** WTB and WTS only. Existing WTT rows migrated to WTB.
   The *commenter* side keeps WTT (`BstMatchIntent`) — a stranger in a thread really can be
   offering a trade.
3. **Notes split into public (`notes`) and private (`privateNotes`).** `location` was already
   private; now it has company and a stated rule: private fields are shown when drafting a post so
   Steve can find the thing, and never included in the post.
4. **Duplicates are legal.** PD-437's `UNIQUE(type, manufacturer, module)` index is dropped.
5. ~~**The matcher resolves every ambiguity towards *not* matching**~~ — **superseded by the PD-475
   amendment above**: an ambiguous mention is recorded as a `possible` match rather than dropped.
   The second half stands: intent is still recorded as `unknown` rather than guessed, and PD-475
   deliberately did not loosen it — a `possible` match has an escape hatch, a wrong intent does not.

**Reasoning:**

- **WTT was never a type, it was a payment method.** "Want to trade for" describes gear Steve would
  *accept* — a want, the same side of the ledger as WTB. Carrying it as a third type meant every
  consumer had to remember that two of three types were wants; that confusion nearly drafted the
  want-list into a for-sale table once already.
- **The uniqueness constraint was wrong about the domain.** Steve owns two of some items, in
  different condition, at different prices, and each is a separate listing. A database that refuses
  to record true facts is a bug. Duplication is now a **question the UI asks** — the route returns
  `409 DUPLICATE_CONFIRM` carrying the existing rows, and re-sending with `confirmDuplicate: true`
  goes through.
- **Import idempotency had to survive the constraint's removal.** The CSV key is now
  `(type, manufacturer, item, condition)` — condition is exactly what distinguishes his duplicates.
  The residual cost is real and stated in the code: two sheet rows identical in all four fields
  collapse to one. Adding `price` to the key would change a row's identity every time he re-priced
  something, which is worse.
- ~~**Precision over recall is a consequence of the schedule, not a preference.**~~ **Superseded —
  see the amendment at the top of this decision.** It was recorded as a consequence and it was
  actually a preference, which is why the owner of the attention budget could overturn it. What
  survives is the observation underneath: his list contains names that are ordinary modular
  vocabulary — `Mix`, `VCA`, `Slice`, `Loop`, `Qua`, `Helium`, `Where?` — and a bare match on one of
  those is not trustworthy. That is now expressed as `possible` confidence instead of as silence.
- **Intent is positional, not a comment-wide vote.** One BST comment routinely carries `WTS:` and
  `WTB:` sections; intent comes from the nearest marker *before* the mention. A comment-wide vote
  would label the WTB line "selling", which is exactly the confident wrongness this feature can't
  afford.

**Implications:** `RENAME COLUMN` is an accepted migration, narrowing `migrate.ts`'s "additive only"
phrasing to its actual rule — *no migration may lose data*. ~~The matcher's `GENERIC_TERMS` list is
**safe to grow and unsafe to shrink**~~ — see the amendment: an entry now only moves a hit between
groups, so growing it is cheaper than it was.

**Revisit if:** ~~the readout is too quiet~~ (that happened, within hours — see the amendment). Or if
he starts wanting
"two of these" tracked as a quantity rather than two rows, in which case duplicates become a
`quantity` column and the confirm flow goes away.
