# D-006: Fuzzy metadata matcher with duration as a gate, not a score component

**Decision:** Two-stage matching. Stage 1: filter library files to those within ±3s of the incoming track's duration. Stage 2: Fuse.js weighted fuzzy score on title (0.50), artist (0.35), remixer (0.15). Threshold 0.65 for "candidate," 0.85 for auto-confirm.

**Reasoning:**

- Duration is gating, not weighted, because a 3-min radio edit and a 7-min extended mix of the same song have identical metadata but are different tracks for a DJ. No amount of title similarity should override a duration mismatch.
- ±3s rather than ±1s because `music-metadata` reads file duration which can be slightly off for VBR MP3s.
- Two thresholds (0.65 / 0.85) let strong matches auto-resolve while medium-confidence matches go to manual review. Starts loose; tighten with observed data.
- Fuse.js because it handles token-set logic and weighted multi-field search well, and it's well-maintained.

**Revisit if:** False positive rate is high — tighten the 0.65 threshold first, then the weights. If false negatives from tag inconsistency dominate, that's the signal to implement Chromaprint (D-004).
