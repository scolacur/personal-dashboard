# D-015: Widget tile as a flippable card component (`lib/Widget.svelte`)

**Decision:** The dashboard home extracts widget tiles into a reusable `Widget.svelte` component. Each widget card has a front face (title + description + link to route) and a rear face (widget name + "Rear panel" stub), flipped by a button in the bottom-right corner using a CSS 3D `rotateY` transition.

**Reasoning:**

- The tile markup was inline in `+page.svelte` with no re-use path. Extracting it to a component keeps the home page clean and gives every widget the same visual chrome for free.
- CSS `transform: rotateY(180deg)` with `transform-style: preserve-3d` and `backface-visibility: hidden` achieves the card-flip animation with zero JavaScript and no extra dependencies.
- The flip button intercepts clicks with `e.preventDefault() + e.stopPropagation()` so the front face's `<a>` link still navigates normally on body clicks.
- The rear face is a stub today; it will host per-widget settings once that feature is built.

**Implications:** All widget registry entries in `lib/widgets.ts` automatically get a flippable card on the home page. Per-widget pages (`routes/widgets/<name>/+page.svelte`) are unaffected — they render their own full-page UI.
