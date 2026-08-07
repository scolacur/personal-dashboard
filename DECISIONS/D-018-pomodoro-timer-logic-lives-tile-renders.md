# D-018: Pomodoro timer logic lives in `packages/shared`; tile renders full widget on home page

**Decision:** Pure Pomodoro timer logic (`formatTime`, `advancePhase`, `clampRoundsBeforeLongBreak`) lives in `packages/shared/src/pomodoro.ts` and is exported from `@dashboard/shared`. The home page renders a `PomodoroTimer.svelte` component directly inside a `.pomodoro-tile` card (not the generic `Widget` link card), so the timer is functional on the dashboard home as well as on its dedicated page.

**Reasoning:**

- Placing pure logic in `packages/shared` follows the established workaround (D-017) for testing shared logic: the server's vitest config imports from `@dashboard/shared` and tests the functions there.
- A generic `Widget` card (link + description) is wrong for the Pomodoro: the issue explicitly requires the timer to be usable inside the tile, not just linked from it. Inline rendering via an `{#if w.id === 'pomodoro'}` branch in `+page.svelte` is the minimal change that satisfies this without modifying the generic `Widget` component.
- Inputs are disabled while the timer is running to prevent confusing mid-session changes; settings take effect on reset or the next phase start.

**Alternatives considered:** Adding a `tileComponent` field to `WidgetMeta` (more generic, but requires importing Svelte component types into the registry); modifying `Widget.svelte` to accept snippet content (also more generic, but requires all callers to pass snippets). The `{#if}` branch is the smallest change and avoids premature abstraction.
