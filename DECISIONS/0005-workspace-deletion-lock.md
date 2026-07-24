# ADR-0005: Workspace-Deletion Lock (R2 Orphan Prevention)

**Status:** Accepted
**Date:** 2026-07-23
**Decider:** Russ Meadows
**Recorder:** Claude
**Severity:** P2 (closes a data-integrity gap; additive schema change, no live-data risk)
**Linked:** `docs/superpowers/specs/2026-07-23-workspace-delete-lock-design.md`, `DECISIONS/0004-phase3-comments-schema.md`, PR #37 (CodeRabbit finding), PR #40

---

## Context

`handleDeleteWorkspace` (`portal-app/worker/src/routes/workspaces.js`) snapshots
`files.r2_key` via a `SELECT` before the D1 batch that deletes those rows
runs. If `handleUploadFile` or `handleReplaceFile`
(`portal-app/worker/src/routes/files.js`) writes a new file row into the same
workspace during that window, the new row's `r2_key` is never captured in
the snapshot, but the workspace-scoped `DELETE FROM files WHERE workspace_id
= ?` removes the row anyway — the R2 object leaks with no DB reference left
to find it. Flagged by CodeRabbit on PR #37, verified real, deferred as out
of scope for that PR (a pure FK-gap fix), and documented as a known
limitation in `DECISIONS/0004-phase3-comments-schema.md` and inline at the
R2 `SELECT` in `workspaces.js`.

An initial design (read a workspace row, check a `deleting_at` flag on it,
then write an unconditional lock `UPDATE`) was reviewed on PR #40 and shown
to still leave the race open: two concurrent deletes can both read
`deleting_at = NULL` before either writes, and an upload/replace that read
the workspace as unlocked has no re-check before its own D1 write, which can
land after a concurrent delete's R2 snapshot but still inside its
workspace-scoped D1 batch. This ADR records the corrected, atomic design.

## Decision

1. **A nullable `deleting_at TEXT` column on `workspaces`** (migration `008`),
   not a separate lock table. `NULL` means "not being deleted"; a value is
   the moment `handleDeleteWorkspace` claimed the lock. Additive
   `ALTER TABLE ADD COLUMN` — no rebuild, mirrors the existing
   `comments.deleted_at` soft-marker convention (`007_comments_notifications.sql`).
   A separate lock table was considered and rejected: it would need its own
   FK to `workspaces` and a join at every call site that checks the flag,
   for no behavior a column can't give — every caller that needs the flag
   already has the workspace row in hand.

2. **The lock is claimed with an atomic conditional `UPDATE`**, immediately
   after `handleDeleteWorkspace` fetches the workspace row and *before* the
   R2-key snapshot `SELECT`:

   ```sql
   UPDATE workspaces SET deleting_at = datetime('now')
   WHERE id = ? AND deleting_at IS NULL
   ```

   The caller checks the result's `meta.changes`: `1` means the lock was
   claimed and the caller proceeds; `0` means someone else already holds it
   — return 409 immediately. This closes the double-delete race precisely
   because the re-check (`deleting_at IS NULL`) happens in the same
   statement as the write; SQLite serializes statement execution, so only
   one of two concurrent callers can win, regardless of what either read
   beforehand. It cannot be folded into the final D1 `batch()` alongside the
   other deletes, because the R2 delete loop (which can take a noticeable
   amount of time for a workspace with many files) runs *between* the lock
   write and that batch — the lock must be visible to concurrent requests
   for that whole window.

3. **Uploads and replaces are gated by atomic guarded writes, not a read
   check.** `assertWorkspaceNotDeleting(workspace)` (a shared helper in
   `workspaces.js`) remains as a fast-path check immediately after each
   handler fetches its workspace/file row — it rejects the overwhelming
   majority of requests once a workspace is locked, without touching R2. But
   because it reads a snapshot taken before the R2 `put()` (real I/O time),
   it cannot by itself close the race. The actual gate is:
   - `handleUploadFile`: the file-row `INSERT` is written as
     `INSERT INTO files (...) SELECT ... WHERE EXISTS (SELECT 1 FROM
     workspaces WHERE id = ? AND deleting_at IS NULL)`. If `meta.changes ===
     0`, the workspace was locked between the fast-path check and this
     write; the handler deletes the R2 object it just wrote (a compensating
     action — R2 and D1 share no transaction) and returns 409.
   - `handleReplaceFile`: the `file_versions` archive `INSERT` is guarded the
     same way (a cheap early exit before the R2 put, in the common
     already-locked case), and the `files` row `UPDATE` — the true gate,
     since it's what makes the new `r2_key` discoverable — is guarded with
     `WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE
     deleting_at IS NULL)`. If that `UPDATE`'s `meta.changes === 0`, the
     handler deletes the new R2 object it just wrote and returns 409. The
     archive row from the first guarded insert is not rolled back in this
     case — it accurately records the pre-replace version, which remains
     true; it's just an archive entry for a replace that didn't ultimately
     commit. Accepted as a low-cost asymmetry rather than added complexity
     to eliminate it.
   - `handleDeleteWorkspace`'s own double-delete guard is the conditional
     lock `UPDATE` in Decision 2 (with its own fast-path check first) — no
     separate mechanism needed.

4. **R2 delete-loop failures are aggregated, not swallowed.** The original
   loop caught and discarded per-object `FILES.delete` failures, which would
   let the D1 batch still remove a file's row while its R2 object survives —
   the same orphan failure mode via a different path. The loop now collects
   failures and throws before the D1 batch runs if any occurred, so the
   failure is caught by the same handler try/catch that clears the lock (see
   Decision 5), leaving every file row (and its still-existing object)
   intact for a retried deletion.

5. **The lock is explicitly cleared on failure.** If the R2 delete loop
   (including the aggregated-failure throw in Decision 4) or the final D1
   batch throws (e.g. an unhandled child-table FK, the same class of failure
   already covered by the existing "rolls back every mutation when the
   workspace delete itself fails" test in `workspaces.test.js`),
   `handleDeleteWorkspace` runs `UPDATE workspaces SET deleting_at = NULL
   WHERE id = ?` before rethrowing. Without this, a failed delete would
   permanently lock the workspace out of future uploads, since the lock
   write already committed separately from the batch that failed.

6. **No stale-lock TTL / self-heal.** If the Worker process dies mid-deletion
   after the lock write but before the catch block can run (e.g. a hard
   CPU-limit kill), the workspace stays locked with no automatic recovery —
   clearing `deleting_at` would need a manual `UPDATE`. Considered and
   rejected a TTL-based self-heal (treat a `deleting_at` older than N minutes
   as abandoned): this is a narrow-window, non-urgent bug to begin with, and
   a manual one-line UPDATE is an acceptable fallback for an event this rare.
   Revisit if it ever actually happens in production.

## Consequences

### Positive
- Closes the actual race, verified atomic rather than assumed: two
  concurrent deletes, or an upload/replace racing a delete's lock
  acquisition, cannot both succeed — the loser gets 409 and (for
  upload/replace) has its R2 write rolled back.
- No rebuild risk — the migration is a single additive `ADD COLUMN`.
- A failed delete no longer has a side effect (a stuck lock) beyond its own
  rollback.

### Negative / things to watch
- A process kill between the lock write and the catch block is an
  unrecoverable-without-manual-intervention edge case (see Decision 6).
  Accepted as out of scope.
- A replace that loses the race leaves one harmless stray `file_versions`
  archive row recording data that was already true (Decision 3). Accepted
  rather than adding a rollback for it.
- This closes the specific window described above; it does not add
  distributed-lock guarantees beyond what SQLite's serialized statement
  execution (which D1 is built on) already provides.

## Verification

```sh
rm -f /tmp/check.db
for migration in portal-app/worker/migrations/*.sql; do
  sqlite3 /tmp/check.db < "$migration"
done
sqlite3 /tmp/check.db ".schema workspaces" | grep deleting_at
```

## References

- `portal-app/worker/migrations/008_workspace_deletion_lock.sql`
- `portal-app/worker/src/routes/workspaces.js` (`assertWorkspaceNotDeleting`, `handleDeleteWorkspace`)
- `portal-app/worker/src/routes/files.js` (`handleUploadFile`, `handleReplaceFile`)
- `docs/superpowers/specs/2026-07-23-workspace-delete-lock-design.md`
