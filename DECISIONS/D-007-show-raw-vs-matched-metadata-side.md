# D-007: Show raw vs matched metadata side-by-side in the review UI

**Decision:** The Review tab shows the detected track and its match candidates as two columns, with raw fields preserved on both sides.

**Reasoning:** The matcher is deliberately loose (biased toward more matches). I can't review borderline matches without seeing both sides. Showing only "matched: yes/no" hides the information needed to tune the matcher over time. Also: nearly free to build, since the DB already stores both sides.

**Implications:** Schema needs a `matches` table (many-to-many) rather than a single `library_match_path` column on `tracks`, so multiple candidates per track can be shown.
