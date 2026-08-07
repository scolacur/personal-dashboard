# D-005: Track status as a small enum, not separate booleans

**Decision:** Single `status` column on tracks: `new` | `in_library` | `wanted` | `acquired` | `ignored`.

**Reasoning:** These states are mutually exclusive in practice. Encoding them as a single field avoids combinations that shouldn't exist (e.g., simultaneously `wanted` and `acquired`). Maps cleanly to UI filters. The `new → wanted/in_library/ignored → acquired` flow gives a natural review queue without committing to any particular download mechanism.

**Revisit if:** I add a "monitoring for better quality" feature — that's a separate axis from the acquisition status and would warrant a second column rather than expanding the enum.
