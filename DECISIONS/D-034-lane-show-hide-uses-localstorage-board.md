# D-034: Lane show/hide uses localStorage; board grid uses grid-auto-flow:column (PD-49)

**Decision:** Lane visibility preference is persisted to `localStorage` (key `agent-dashboard:hidden-lanes`) with no backend involvement. The board CSS was changed from `grid-template-columns: repeat(N, ...)` to `grid-auto-flow: column; grid-auto-columns: minmax(190px, 1fr)` so the grid adapts to any number of visible lanes without leaving empty column slots.

**Why:** The issue spec explicitly required client-side-only persistence. Implicit grid columns (`grid-auto-flow: column`) are the correct primitive here because the number of visible lanes is dynamic — an explicit `repeat(7, ...)` would create empty columns when lanes are hidden.
