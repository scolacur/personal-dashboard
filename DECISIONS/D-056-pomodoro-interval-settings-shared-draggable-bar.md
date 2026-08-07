# D-056: Pomodoro interval settings as a shared draggable bar-graph component (`IntervalBars`) rather than duplicated `<input type="number">` rows (#235)

> **Note (PD-490):** this number was claimed twice. PR #235 (below) took it first and keeps it;
> PR #237's arrange-mode decision, which also shipped as D-056, is now [[D-069]].

**Decision:** Extract the five Pomodoro setting inputs (Work, Short Break, Long Break, Rounds → Long Break, Total Rounds) into a single shared component `apps/web/src/lib/pomodoro/IntervalBars.svelte` using vertical draggable bar graphs. Both `PomodoroTimer.svelte` and `FloatingPomodoro.svelte` consume it via `bind:` props + per-field `onChange` callbacks. The bars use independent Y-axes (each bar scaled to its own min/max), snap duration bars to 5-minute steps and count bars to 1, and use a two-layer `clip-path` technique for the value label to remain legible at any fill level.

**Alternatives considered:**
- Keep the number spinners and just extract the duplicate row markup into a shared component — would remove duplication but the ticket explicitly calls for a bar-graph control.
- A generic reusable slider — explicitly out of scope; kept Pomodoro-specific in `lib/pomodoro/`.

**Why clip-path for label legibility:** Two identical `<span>` elements are rendered; the first uses `--text` color (legible on the unfilled surface), the second is clipped via `clip-path: inset(calc(100% - var(--fill)) 0 0 0)` to the filled region and uses `--on-accent` (legible on the accent fill). This produces a smooth split-text effect at any fill level without JS-based threshold checks.
