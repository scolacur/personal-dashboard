# D-093: The shared offline outbox is a plain module with an `onChange` callback, not a reactive `.svelte.ts` store

**Context.** The Tinnitus Tracker's offline outbox was lifted into `apps/web/src/lib/outbox.ts`
so a second widget (the Habit Tracker, PD-361) can reuse it without a widget-to-widget import
(PROJECT.md §5). The outbox owns a `pending` list that a component renders live ("N pending sync").
The obvious shape for shared reactive state here is a `.svelte.ts` store with `$state`, the way
`toast-store.svelte.ts` does it.

**Decision.** `outbox.ts` stays a **plain** TypeScript module. `createOutbox` owns the queue as an
ordinary array and reports changes through an `onChange(pending)` callback; the consuming component
mirrors that into its own `$state` (Tinnitus does `onChange: (list) => (pending = list)`). The
module does **not** use runes and is **not** named `.svelte.ts`.

**Why.**

- **Unit-testability.** `apps/web/vitest.config.ts` deliberately runs the specs with *no* Svelte
  plugin — they are pure-TS. A module using `$state` cannot be transformed or instrumented by that
  config, so the hard logic (the oldest-first flush loop, the try/catch persistence, the
  re-entrancy guard) would become untestable. Keeping the module plain keeps all of it covered by
  `src/lib/outbox.spec.ts`. The one genuinely browser-only piece — the `online` / focus / interval
  retry wiring in `start()` — is guarded with `typeof window` and left uncovered, as it was when it
  lived inline in the component.
- **It honours the ticket.** The ticket named the target `lib/outbox.ts`; a reactive store would
  have forced `lib/outbox.svelte.ts`.
- **Reactivity stays where Svelte wants it.** The caller holds the `$state`; the outbox stays a
  framework-agnostic utility, which also means a non-Svelte caller could use it.

**Consequence.** A caller must pass `onChange` and copy the list into its own reactive state to get
a live count — the outbox will not make a bare import reactive on its own. That is the small price
for a testable, plain module. Cited in `apps/web/src/lib/outbox.ts`.
