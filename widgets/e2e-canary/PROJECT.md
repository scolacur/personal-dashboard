# E2E Canary — PROJECT.md

A throwaway widget that exists so the **E2E loop test** (PD-891 E2E loop test suite; kit PD-892
Loop test kit) has somewhere harmless to build. Test tickets add features here; the test's reset
puts it back to the baseline tag `e2e-canary-baseline`.

## Rules

- **It is not a real widget.** Don't build on it, link to it, or place it on a page. It is in the
  widget library only (D-073), so its route works.
- **The baseline is deliberately minimal:** a `GET /api/widgets/e2e-canary/health` route, a
  heading-only page, and the `e2e_canary_items` table (`id`, `label`, `created_at`).
- **The scaffold owns the shared files:** `schema.ts` and the registrations in
  `apps/server/src/index.ts` and `apps/web/src/lib/widgets.ts` already exist. Canary work stays
  inside `apps/server/src/widgets/e2e-canary/` and `apps/web/src/routes/widgets/e2e-canary/`.

## Domain

An **item** is a label (1–80 characters after trimming) plus the time it was created. Items list
newest-first. That's the whole domain, on purpose.
