# D-048: Acute Strategies Generator stores tags as a JSON array in a SQLite TEXT column (PD-202)

**Decision:** Idea tags are stored as a JSON array in a `TEXT` column (`tags TEXT NOT NULL DEFAULT '[]'`), not in a separate join table.

**Why:** The ideas list is small (O(100) entries), tags are only used for client-side filtering, and a join table adds schema complexity with no benefit at this scale. SQLite's built-in JSON support lets us parse/serialize in the store layer without any extra SQL joins.

**Trade-off:** Tag-based aggregation queries (e.g. "count ideas per tag") would require JSON parsing in SQL or in application code. Acceptable for a personal dashboard; revisit if a tag management UI becomes needed.
