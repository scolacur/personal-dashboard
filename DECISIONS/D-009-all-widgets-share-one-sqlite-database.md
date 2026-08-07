# D-009: All widgets share one SQLite database, namespaced by table prefix

**Decision:** Every widget stores data in the shared SQLite DB (`data/dashboard.db`). Tables are prefixed with the widget name (e.g., `habit_log_*`, `morning_routine_*`). No per-widget DB files.

**Reasoning:**

- A single DB file is trivially backed up and mounted in Docker.
- SQLite supports concurrent reads and serialized writes without any extra service — a separate DB per widget would add filesystem complexity with no benefit at this scale.
- Table namespacing is enough isolation; cross-widget queries are unlikely and can be discouraged by convention. If it ever matters, SQLite's `ATTACH DATABASE` handles it without breaking the single-file model.

**Revisit if:** A widget needs a fundamentally different storage model (e.g., blob storage, vector DB) that SQLite doesn't handle well.
