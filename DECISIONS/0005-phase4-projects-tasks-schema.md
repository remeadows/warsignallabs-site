# ADR-0005: Phase 4 Schema — Projects, Tasks

**Status:** Accepted
**Date:** 2026-07-23
**Decider:** Russ Meadows
**Recorder:** Claude
**Severity:** P2 (routine schema evolution, no live-data risk — both tables are entirely new)
**Linked:** `portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2 items 4/7, `docs/superpowers/specs/2026-07-23-phase4-projects-tasks-home-design.md`

---

## Context

Phase 4 (`worker/migrations/008_projects_tasks.sql`) adds workspace-scoped projects
and tasks. Per `AGENTS.md` §5.3 ("Don't modify D1 schema without an ADR"), this
records the decisions the migration encodes.

## Decision

1. **Both tables are entirely new** — `CREATE TABLE` only, no `ALTER TABLE` on any
   existing table in this migration. None of ADR-0004's D1 rename/rebuild sharp
   edges (widening a `CHECK` after live data exists) apply here.

2. **`tasks.sort_order` is write-once, not a live reordering mechanism.** Set at
   task creation to `(current max in that project+status) + 1`; no Phase 4 code
   path ever updates it after that. The plan's "move via button/dropdown, not
   drag-drop yet" language was brainstormed to refer to moving a task *between
   status columns* (a `status` change), not manual position-within-column
   reordering — that's explicitly Phase 5 (drag-drop board) scope. The column
   exists now so Phase 5 doesn't need its own migration.

3. **`idx_tasks_assignee` is a composite index on `(assignee_id, status, due_date)`**,
   not in the plan's original one-column sketch — added because it's exactly what
   the new `GET /api/me/tasks` query needs (`WHERE assignee_id = ? AND status !=
   'done' ORDER BY due_date`). Same proactive-index precedent as ADR-0004's
   `audit_log` composite index for the Activity feed.

4. **`workspace_id` FK deletion behavior matches every other same-shape FK in this
   schema** (`files`, `folders`, `invitations`, `user_workspaces`, `comments`): no
   `ON DELETE` clause. `projects` and `tasks` join the explicit-delete list in
   `handleDeleteWorkspace` rather than introducing FK-cascade as a one-off
   exception. `tasks.project_id` also has no `ON DELETE` clause — a project is
   never hard-deleted via the resource-level API (see the design spec's
   delete-cascade rule, which handles this at the application layer instead).
   The one place FK behavior IS exercised is workspace teardown:
   `handleDeleteWorkspace` hard-deletes child rows, and must delete `tasks`
   before `projects` or the `tasks.project_id` constraint rejects the project
   delete — that ordering is load-bearing, not stylistic.

5. **`projects.status` and `tasks.status` are constrained at the DB level**
   (`CHECK (status IN (...))` on both), continuing ADR-0004's rule of constraining
   enum-like columns in SQL from day one, not just in the application layer.

## Consequences

### Positive
- No rebuild-with-sharp-edges risk from this migration — both tables are brand new.
- The Phase 5 drag-drop board can implement reordering by writing to an existing
  column instead of needing its own schema change.
- The My Tasks query has its composite index from day one instead of degrading as
  task volume grows.

### Negative / things to watch
- `sort_order` sits unused (beyond append-on-create) for an entire phase. If Phase
  5's actual reordering algorithm needs a different value shape (e.g. fractional
  midpoint insertion vs. simple integer append), this phase's values may need a
  one-time backfill — low cost at expected task volumes (2 users, dozens of tasks
  per project at most).
- Same application-level-only enforcement caveat as ADR-0004: a future direct-SQL
  `DELETE FROM workspaces` bypassing `handleDeleteWorkspace` would be rejected by
  the FK constraint while `projects`/`tasks` rows still reference it, not silently
  orphaned. Keep `handleDeleteWorkspace`'s explicit-delete list in sync with what
  references `workspaces.id` if it's ever refactored.

## Verification

```bash
rm -f /tmp/check.db
for migration in portal-app/worker/migrations/*.sql; do
  sqlite3 /tmp/check.db < "$migration"
done
sqlite3 /tmp/check.db ".schema projects" | grep -E "CHECK.*status"
sqlite3 /tmp/check.db ".schema tasks" | grep -E "CHECK.*status"
sqlite3 /tmp/check.db ".indexes tasks" | grep idx_tasks_assignee
```

## References

- `portal-app/worker/migrations/008_projects_tasks.sql`
- `docs/superpowers/specs/2026-07-23-phase4-projects-tasks-home-design.md` §1, §2
- `DECISIONS/0004-phase3-comments-schema.md` (precedent for the D1 rename/rebuild
  caution and the constrain-enums-in-SQL rule)
