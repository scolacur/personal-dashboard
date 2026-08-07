# D-049: Acute Strategies Generator uses client-side filtering and randomisation (PD-202)

**Decision:** All ideas are loaded once via `GET /api/widgets/acute-strategies-generator/ideas`. Filtering by type/tag and random selection are done in the browser.

**Why:** The ideas list is small enough that loading all of them upfront is negligible. Client-side randomisation avoids a network round-trip on every Shuffle press and makes the filter interaction feel instant.

**Trade-off:** If the list grew very large (thousands of items), this would need revisiting. Not a concern for a personal creative list.
