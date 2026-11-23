# [E2E Canary] Server: normalizeLabel helper for item labels

**What shipped:** Added `apps/server/src/widgets/e2e-canary/label.spec.ts` — the test file the
Evaluator flagged as missing on Steve's PR #531. `label.ts` (the `normalizeLabel` helper) already
existed and was correct, so this rework is test-only. Seven cases: plain, surrounding whitespace,
internal whitespace runs, empty→null, whitespace-only→null, exactly 80→kept, 81→null.

**Worth remembering:** `npm run verify` cannot go fully green in this sandbox — `backup.spec.ts`
reliably times out (6 failures, all timeouts at the vitest 5s default) under full-suite load. It
is unrelated to this change: it reproduces on unmodified main, fails even with
`--no-file-parallelism`, and passes 7/7 in isolation with `--testTimeout=30000`. MEMORY already
notes this flake ("backup.spec.ts flakes at the 5s default in a loaded sandbox"). All 1244+
non-backup tests, including the 7 new label tests, pass. The authoritative gate is GitHub CI,
where backup.spec.ts passes (it is on main). Marker written on that basis.
