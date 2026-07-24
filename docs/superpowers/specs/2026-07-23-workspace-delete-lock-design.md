# Design: workspace-deletion lock (R2 orphan-prevention)

**Date:** 2026-07-23
**Status:** Approved (revised after review — see Revision note)
**Author:** Claude

## Revision note (post-review)

The first version of this design used a plain read-then-write check
(`assertWorkspaceNotDeleting` against a previously-fetched workspace row,
followed by an unconditional lock `UPDATE`). Review (CodeRabbit + Codex on
PR #40) correctly identified that this does not actually close the race:

- Two concurrent `handleDeleteWorkspace` calls can both read `deleting_at =
  NULL` before either writes, so an unconditional `UPDATE ... WHERE id = ?`
  succeeds for both — the promised 409 on a second delete attempt does not
  hold.
- An upload/replace that reads the workspace as unlocked, then spends time
  on its R2 `put()`, has no re-check before its D1 write. If a concurrent
  `handleDeleteWorkspace` claims the lock and runs its snapshot+batch during
  that window, the new file can still end up with an R2 object and no
  surviving D1 row — exactly the orphan this design exists to prevent.

This revision replaces every read-then-write check with an atomic
(compare-and-set style) write: the lock claim and the file writes are each a
single SQL statement whose `WHERE` clause re-validates state at the instant
it executes, not at the instant it was last read. SQLite (and D1, built on
it) executes each statement serially against the database, so this is a real
guarantee, not a narrower race. See "Enforcement" below for the concrete
statements.

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

Add a **"workspace is being deleted" lock**. The lock claim, and every write
that must respect it, are atomic single-statement compare-and-set operations
— see "Schema" and "Enforcement" below for why a plain read-then-write check
is not sufficient on its own.

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

### Claiming the deletion lock (atomic)

In `handleDeleteWorkspace`, immediately after fetching the workspace row and
**before** the R2-key `SELECT`, the lock is claimed with a conditional
`UPDATE` whose `WHERE` clause re-checks `deleting_at IS NULL` at write time:

```sql
UPDATE workspaces SET deleting_at = datetime('now')
WHERE id = ? AND deleting_at IS NULL
```

The caller checks the D1 result's `meta.changes`. If `1`, the lock was
claimed and the caller proceeds. If `0`, someone else already holds it (or
claimed it a moment ago) — return `409` immediately, without touching R2 or
running any further queries.

This is the mechanism that actually closes the double-delete race: two
concurrent callers can both pass an earlier read-based check, but only one of
them can win this `UPDATE` — SQLite serializes statement execution, so
`changes` is authoritative regardless of what either caller read before this
point.

This write is its own committed statement — it cannot be folded into the
final D1 `batch()` alongside the other deletes, because the R2 delete loop
(which can take a noticeable amount of time for a workspace with many files)
runs *between* the lock write and that batch. The lock must be visible to
concurrent requests for that whole window, not just during the final batch.

### Enforcement in `files.js`: fast-path check + atomic guarded write

A small exported helper in `workspaces.js`, unchanged from the first
revision:

```js
export function assertWorkspaceNotDeleting(workspace) {
  if (workspace?.deleting_at) {
    throw errorResponse('Workspace is being deleted', 409)
  }
}
```

This is called immediately after `handleUploadFile` and `handleReplaceFile`
fetch the workspace/file row — it's a **fast-path optimization**, not the
correctness guarantee. Once a workspace enters deletion, this check rejects
the overwhelming majority of subsequent requests immediately, before any R2
traffic. But because it reads a snapshot taken before the R2 `put()` (which
can take real time), it cannot by itself close the race described in the
Revision note.

The actual gate is an atomic guarded D1 write, one per handler:

**`handleUploadFile`** — after the R2 `put()` (unchanged position in the
existing code), the file row insert is conditioned on the workspace still
being unlocked, in the same statement:

```sql
INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes,
                    content_type, uploaded_by, folder_id, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND deleting_at IS NULL)
```

If `meta.changes === 0`, the workspace was locked between the fast-path check
and this statement. The handler deletes the R2 object it just wrote (a
compensating action — R2 and D1 have no shared transaction) and returns 409.
If `changes === 1`, the row committed normally and the handler continues as
before (audit log, notification, response).

**`handleReplaceFile`** — the archive-to-`file_versions` insert and the
`files` row update are each guarded the same way:

```sql
-- 1. Archive current version (guarded) — checked and, if it no-ops, the
--    handler returns 409 immediately, before the R2 put below.
INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes,
                            content_type, uploaded_by, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now')
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND deleting_at IS NULL)

-- 2. R2 put of the new version happens here, unchanged position —
--    only reached if step 1 committed a row.

-- 3. Update files record (guarded again — the true gate: this is what
--    makes the new r2_key discoverable at all)
UPDATE files SET r2_key = ?, size_bytes = ?, content_type = ?, filename = ?,
                 version = ?, uploaded_by = ?, created_at = datetime('now')
WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE deleting_at IS NULL)
```

Step 1 is a cheap early exit (skips the R2 put entirely in the common case).
Step 3 is the authoritative gate: if `meta.changes === 0`, the handler
deletes the new R2 object it just wrote and returns 409. The step-1 archive
row is *not* rolled back in this case — it accurately records that version
`file.version` had `r2_key = file.r2_key`, which remains true; it's just an
archive entry for a replace that ultimately didn't commit. Not incorrect
data, just a low-cost asymmetry in a race this narrow, and simpler than
combining both statements into one batch purely to avoid it.

**`handleDeleteWorkspace`**'s own double-delete guard is the conditional lock
`UPDATE` described above (with its own `assertWorkspaceNotDeleting` fast-path
check first, for the same early-exit reason) — no separate mechanism needed.

### R2 delete-loop failures must not be swallowed

The original R2 delete loop in `handleDeleteWorkspace` caught and discarded
per-object failures:

```js
for (const f of files.results) {
  try { await env.FILES.delete(f.r2_key) } catch { /* continue */ }
}
```

If any single `FILES.delete` call fails, the D1 batch below would still run
and remove that file's row — leaving the (still-existing) R2 object with no
D1 reference, the same failure mode as the race this design closes, just via
a different path. The loop now aggregates failures instead of swallowing
them, and aborts *before* the D1 batch if any occurred:

```js
const r2Failures = []
for (const f of files.results) {
  try {
    await env.FILES.delete(f.r2_key)
  } catch (err) {
    r2Failures.push({ r2_key: f.r2_key, error: err.message })
  }
}
if (r2Failures.length > 0) {
  throw new Error(`Failed to delete ${r2Failures.length} R2 object(s): ${r2Failures.map((f) => f.r2_key).join(', ')}`)
}
```

This throw is caught by the same try/catch that already wraps the R2 loop
and D1 batch (see next section) — the lock is cleared and the error
propagates as a 500, leaving every file row (and its still-existing R2
object) intact for a retried deletion.

### Failure handling — clearing the lock on a failed delete

If the R2 delete loop (including the aggregated-failure throw above) or the
final D1 batch throws (e.g. the FK-gap scenario already covered by the
existing "rolls back every mutation when the workspace delete itself fails"
test in `workspaces.test.js`), the lock claimed earlier must not be left
behind — otherwise a failed delete permanently locks the workspace out of
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

Async JS in a single test process can't produce genuine concurrent
statement execution, so "simulate two requests racing" tests would only
prove our test double's behavior, not the real guarantee. Instead, each
mechanism is tested at the level where its guarantee actually holds:

- **The atomic lock-acquisition `UPDATE` is correct regardless of read
  history** — tested directly against the database, independent of any
  handler call: claim the lock twice in a row and assert the first call's
  `changes` is `1` and the second's is `0`. This is what proves the guard
  is race-safe (SQLite serializes the two statements deterministically),
  not a timing simulation.
- **A race the fast-path check cannot catch is still closed** — in
  `files.test.js`, the test's R2 bucket double's `put()` is used as the
  injection point for "a concurrent delete claims the lock while this
  upload/replace's R2 write is in flight" (a real window — R2 I/O takes
  real time in production): the test's `put()` implementation flips
  `deleting_at` on the workspace as a side effect, *after* the handler's own
  fast-path check has already passed. Assert the handler returns 409, no
  file row was written, and the R2 object was rolled back (the bucket
  double ends up empty).
- Extend `portal-app/worker/src/routes/workspaces.test.js`:
  - The atomic lock-acquisition test above (direct DB-level).
  - A second `handleDeleteWorkspace` call on a workspace whose `deleting_at`
    is already set (fast-path check) returns 409 and makes no further
    changes.
  - The existing "rolls back every mutation when the workspace delete itself
    fails" test additionally asserts `deleting_at` is `NULL` after the
    failure (lock cleared, not left stuck).
  - A failing `FILES.delete` call aborts before the D1 batch runs (file rows
    still exist, still pointing at their un-deleted R2 objects) and still
    clears the lock.
- New `portal-app/worker/src/routes/files.test.js`, using the same
  real-migrations-in-SQLite pattern as `workspaces.test.js` (not a mocked DB —
  the point of this fix is DB-visible state a mock can't represent
  faithfully):
  - `handleUploadFile` rejects with 409 when the target workspace's
    `deleting_at` is already set at request start (fast path); a normal
    upload with no lock set is unaffected.
  - `handleUploadFile` rejects with 409 and rolls back its R2 object when the
    workspace is locked *during* the upload (the race-injection test above).
  - `handleReplaceFile` rejects with 409 when the file's workspace
    `deleting_at` is already set at request start (fast path); a normal
    replace with no lock set is unaffected.
  - `handleReplaceFile` rejects with 409 and rolls back its new-version R2
    object when the workspace is locked *during* the replace.

## Verification

Full repo standard from `portal-app/worker/`:

```sh
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
