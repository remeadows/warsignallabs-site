# Design: workspace-deletion lock (R2 orphan-prevention)

**Date:** 2026-07-23
**Status:** Approved
**Author:** Claude

## Problem

`handleDeleteWorkspace` (`portal-app/worker/src/routes/workspaces.js`) snapshots
`files`/`file_versions.r2_key` via a `SELECT` before the D1 batch that deletes
those rows runs. If `handleUploadFile` or `handleReplaceFile`
(`portal-app/worker/src/routes/files.js`) writes a new file row into the same
workspace during that window, the new row's `r2_key` is never captured in the
snapshot, but the workspace-scoped `DELETE FROM files WHERE workspace_id = ?`
removes the row anyway — the R2 object leaks with no DB reference left to find
it.

Flagged by CodeRabbit on PR #37, verified real, deferred as out of scope for
that PR (a pure FK-gap fix), and documented as a known limitation in
`DECISIONS/0004-phase3-comments-schema.md` and inline at the R2 `SELECT` in
`workspaces.js`. Not urgent (admin-triggered deletion racing an in-flight
upload is a narrow window) but real in a multi-user workspace.

## Approach

Add a **"workspace is being deleted" lock**, closing the window rather than
eliminating every theoretical race (see Alternatives Considered).

### Schema: a column, not a lock table

`ALTER TABLE workspaces ADD COLUMN deleting_at TEXT` — nullable timestamp,
`NULL` when the workspace is not being deleted. Additive `ADD COLUMN`, no
rebuild, no `CHECK` needed (a timestamp-or-null needs no enum). Mirrors the
existing `comments.deleted_at` soft-marker convention already in this schema
(`007_comments_notifications.sql`).

A separate lock table (`workspace_deletion_locks` or similar) was considered
and rejected: it would need its own FK to `workspaces` and a join at every
call site that checks the flag, for no behavior a column can't give — every
caller that needs the flag already has the workspace row in hand.

### Where the lock is set

In `handleDeleteWorkspace`, immediately after fetching the workspace row and
**before** the R2-key `SELECT`:

```
UPDATE workspaces SET deleting_at = datetime('now') WHERE id = ?
```

This is its own committed write — it cannot be folded into the final D1
`batch()` alongside the other deletes, because the R2 delete loop (which can
take a noticeable amount of time for a workspace with many files) runs
*between* the lock write and that batch. The lock must be visible to
concurrent requests for that whole window, not just during the final batch.

### Enforcement point

A small exported helper in `workspaces.js`:

```js
export function assertWorkspaceNotDeleting(workspace) {
  if (workspace?.deleting_at) {
    throw errorResponse('Workspace is being deleted', 409)
  }
}
```

Used by:
- `handleUploadFile` (`files.js`) — after fetching the workspace, before the R2
  `put()` and D1 insert.
- `handleReplaceFile` (`files.js`) — after fetching the file+workspace join
  (which will select `w.deleting_at`), before archiving the current version.
- `handleDeleteWorkspace` itself — rejects a second concurrent delete attempt
  on the same workspace with the same 409, instead of racing its own R2
  snapshot/delete logic against another in-flight deletion of the same
  workspace.

### Failure handling — clearing the lock on a failed delete

Not in the original ask, but necessary: if the R2 delete loop or the final D1
batch throws (e.g. the FK-gap scenario already covered by the existing "rolls
back every mutation when the workspace delete itself fails" test in
`workspaces.test.js`), the lock write already committed separately must not be
left behind — otherwise a failed delete permanently locks the workspace out of
future uploads with no path to recovery.

`handleDeleteWorkspace` wraps the R2-delete-loop + D1 batch in try/catch. On
any failure it runs `UPDATE workspaces SET deleting_at = NULL WHERE id = ?`
before rethrowing. On success, the batch's own `DELETE FROM workspaces`
removes the row entirely, so no explicit unlock is needed on the happy path.

The existing regression test is extended to assert `deleting_at` is `NULL`
again after a failed delete, in addition to its existing assertion that the
workspace row still exists.

### Stale-lock recovery: explicitly out of scope

If the Worker process dies mid-deletion after the lock write but before the
catch block can run (e.g. a hard CPU-limit kill), the workspace would stay
locked with no automatic recovery — clearing `deleting_at` would require a
manual `UPDATE`. Considered a TTL-based self-heal (treat a `deleting_at` older
than N minutes as abandoned) and decided against it: this is a simpler,
narrower fix for a narrow-window, non-urgent bug, and a manual one-line UPDATE
is an acceptable fallback for an event this rare. Revisit if it ever actually
happens in production.

## Testing plan

- Extend `portal-app/worker/src/routes/workspaces.test.js`:
  - A second `handleDeleteWorkspace` call on a workspace whose `deleting_at`
    is already set returns 409 and makes no further changes.
  - The existing "rolls back every mutation when the workspace delete itself
    fails" test additionally asserts `deleting_at` is `NULL` after the
    failure (lock cleared, not left stuck).
- New `portal-app/worker/src/routes/files.test.js`, using the same
  real-migrations-in-SQLite pattern as `workspaces.test.js` (not a mocked DB —
  the point of this fix is DB-visible state a mock can't represent
  faithfully):
  - `handleUploadFile` rejects with 409 when the target workspace's
    `deleting_at` is set; a normal upload with no lock set is unaffected.
  - `handleReplaceFile` rejects with 409 when the file's workspace
    `deleting_at` is set; a normal replace with no lock set is unaffected.

## Verification

Full repo standard from `portal-app/worker/`:
```
npm test
npm run lint
npm run build
npx wrangler deploy --dry-run
```

## Artifacts

- Migration: `portal-app/worker/migrations/008_workspace_deletion_lock.sql`
- ADR: `DECISIONS/0005-workspace-deletion-lock.md` (per `AGENTS.md` §5.3 /
  `CLAUDE.md` — no D1 schema change without an ADR)
- Code: `portal-app/worker/src/routes/workspaces.js`,
  `portal-app/worker/src/routes/files.js`
- Tests: `portal-app/worker/src/routes/workspaces.test.js`,
  `portal-app/worker/src/routes/files.test.js` (new)
