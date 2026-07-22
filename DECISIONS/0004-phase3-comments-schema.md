# ADR-0004: Phase 3 Schema — Comments, Notification Inbox, Email Preference

**Status:** Accepted
**Date:** 2026-07-22
**Decider:** Russ Meadows
**Recorder:** Claude
**Severity:** P2 (routine schema evolution, no live-data risk — all changes are additive)
**Linked:** `portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2.4/§3.5, `docs/superpowers/specs/2026-07-19-phase3-comments-activity-notifications-design.md`, PR #29

---

## Context

Phase 3 (`worker/migrations/007_comments_notifications.sql`) adds workspace/file comments, an in-app notification inbox, and per-user email preferences. Per `AGENTS.md` §5.3 ("Don't modify D1 schema without an ADR"), this records the decisions the migration encodes. (Migrations `000`–`006` predate this ADR discipline being flagged in review — this is the first one written for a D1 schema change in this repo.)

## Decision

1. **New tables, not extensions of existing ones.** `comments` and `notification_inbox` are new tables rather than repurposing `notifications` (the Phase 1 Resend send-log). Different lifecycle, different consumer — `notifications` stays the email-delivery audit trail, `notification_inbox` is purely in-app bell/read state.

2. **`comments.entity_type` includes `'task'` now**, even though Phase 4 (projects/tasks) hasn't shipped. A prior incident this session (widening a `CHECK` constraint after a table already had live data required a rename-and-rebuild with D1-specific sharp edges) made locking the enum in while the table is brand new and empty the safer call than repeating that rebuild in Phase 4. The API layer (`routes/comments.js`) still rejects `entity_type: 'task'` at request time until Phase 4 actually implements tasks — the schema is future-provisioned, the API surface is not.

3. **`workspace_id` FK deletion behavior is NOT uniform across the two new tables** — deliberately:
   - `comments.workspace_id` has no `ON DELETE` clause, matching every other `workspace_id` FK in this schema (`files`, `folders`, `invitations`, `user_workspaces`). `handleDeleteWorkspace` explicitly `DELETE`s each of those before removing the workspace row; comments joins that same explicit-delete list (see code change in this PR) rather than introducing FK-cascade as a one-off exception.
   - `audit_log.workspace_id` uses `ON DELETE SET NULL` instead. Audit history is a record of what happened and must survive workspace deletion — nulling the FK (rather than cascading the delete, or leaving it to silently violate a NOT NULL/RESTRICT-style constraint and block workspace deletion entirely) preserves the row while detaching it from a workspace that no longer exists.
   - Both `email_pref` and `workspace_id` are additive (`ADD COLUMN`) — no rename/rebuild, none of the D1-specific sharp edges from the incident in (2) apply here.

4. **`audit_log(workspace_id, created_at)` composite index added** in this migration, ahead of the Activity feed endpoint (`GET /api/workspaces/:slug/activity`) that filters and orders on exactly those two columns — added proactively rather than discovered as a slow-query fix later.

5. **`email_pref` is constrained at the DB level** (`CHECK (email_pref IN ('all','mentions','none'))`) from day one, not just validated in the application layer — same lesson as the `users.status` enum incident earlier this session.

## Consequences

### Positive
- No rebuild-with-sharp-edges risk from this migration — everything is a `CREATE TABLE` or additive `ALTER TABLE ADD COLUMN`.
- Workspace deletion continues to work once comments/audit history exist (previously would have hit a live-data bug on the first workspace delete after this phase shipped, since neither new table's deletion behavior had been decided before review).
- Activity feed query has its index from day one instead of degrading into full scans as audit history grows.

### Negative / things to watch
- The `'task'` value in `entity_type`'s `CHECK` is unused until Phase 4. If Phase 4's task-comment design ends up needing a different shape than "file comments but for tasks," this pre-provisioning was wasted (low cost — it's one CHECK-list value, not a structural commitment).
- `comments` deletion on workspace-delete is now application-level: a future direct-SQL `DELETE FROM workspaces` that bypasses `handleDeleteWorkspace` would be **rejected** by the FK constraint while comment rows still reference it (not silently orphaned — orphans are only possible if FK enforcement is bypassed or disabled entirely). Same behavior already applies to `files`/`folders`/`invitations`/`user_workspaces` — not new, but worth remembering if `handleDeleteWorkspace` is ever refactored: the app-level deletes must stay in sync with what references `workspaces.id`.

## Verification

```bash
rm -f /tmp/check.db
for migration in portal-app/worker/migrations/*.sql; do
  sqlite3 /tmp/check.db < "$migration"
done
sqlite3 /tmp/check.db ".schema audit_log" | grep "ON DELETE SET NULL"
sqlite3 /tmp/check.db ".indexes audit_log" | grep idx_audit_log_workspace_activity
```

## References

- `portal-app/worker/migrations/007_comments_notifications.sql`
- `portal-app/worker/src/routes/comments.js` (entity_type validation, workspace-delete wiring)
- `portal-app/worker/src/routes/workspaces.js` (`handleDeleteWorkspace`, `handleGetActivity`)
- `docs/superpowers/specs/2026-07-19-phase3-comments-activity-notifications-design.md` §1
- `docs/superpowers/plans/2026-07-21-portal-phase3-collab.md` Task 1
