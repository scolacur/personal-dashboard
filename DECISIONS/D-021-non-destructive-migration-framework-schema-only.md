# D-021: Non-destructive migration framework — schema only ever grows

**Decision:** All Agent Dashboard schema evolution goes through a small migration framework
(`apps/server/src/migrate.ts`): a `_migrations` ledger table, a `migrate(db, id, fn)` runner that
executes each step once inside a transaction and records it, and additive helpers `columnExists` /
`addColumn`. Migrations may **create tables or ADD columns — never drop or recreate**. `CREATE TABLE
IF NOT EXISTS` statements carry the full current schema (so fresh DBs are complete in one shot); the
`addColumn` migrations bring pre-existing tables up to date and are no-ops on a fresh DB.

**Reasoning:**

- Steve's explicit requirement: "it is inevitable that we will need to update the data model as we
  go along… I want to be sure we can do so safely without getting rid of existing data." The prior
  approach (`CREATE TABLE IF NOT EXISTS` only) safely adds *new tables* but silently fails to evolve
  an *existing* table (won't add a column), and a drop/recreate would destroy data.
- Append-only migrations + a ledger make evolution deterministic and idempotent: a step runs at most
  once, a failed step rolls back (transaction) and retries next boot, and shipped migrations are
  never edited — you add new ones. This is the durable complement to the off-box Backblaze backups
  (the HIGH `SQLite backup` TODO): backups protect against loss, migrations protect against
  destructive change.

**Implications:** Adding a field later is a one-line `addColumn` migration, no data risk. Proven in
this build: `project_id`, `display_id`, `archived_at`, `assignee`, `recur_interval`, and
`agent_projects.key`/`seq` were all added to a pre-existing `agent_tickets`/`agent_projects` without
data loss.
