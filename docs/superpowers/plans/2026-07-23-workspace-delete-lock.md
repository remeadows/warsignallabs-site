# Workspace-Deletion Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the race between `handleDeleteWorkspace`'s R2-key snapshot and an in-flight file upload/replace, so a workspace deletion can no longer orphan an R2 object with no surviving D1 reference.

**Architecture:** Add a nullable `deleting_at` timestamp column to `workspaces`. Every write that must respect the lock — claiming it, inserting a new file, updating a file on replace — is an atomic (compare-and-set style) single SQL statement whose `WHERE` clause re-validates state at execution time, not at the time it was last read. A read-based `assertWorkspaceNotDeleting()` check remains as a fast-path optimization only; it is not the correctness guarantee (see Revision note below).

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest with `node:sqlite` running the real migration files (no mocked DB — this bug class is invisible to a mocked prepare()).

## Revision note

This plan was revised after review on PR #40 (CodeRabbit + Codex) correctly
identified that the first version's design — a read-based
`assertWorkspaceNotDeleting()` check followed by an *unconditional* lock
`UPDATE` — does not actually close the race:
- Two concurrent `handleDeleteWorkspace` calls can both read `deleting_at =
  NULL` before either writes, so an unconditional `UPDATE ... WHERE id = ?`
  succeeds for both.
- An upload/replace that reads the workspace as unlocked, then spends real
  time on its R2 `put()`, has no re-check before its D1 write — a concurrent
  delete can claim the lock and run its snapshot+batch during that window,
  still producing exactly the orphan this design exists to prevent.

Every task below now uses atomic guarded writes (`WHERE deleting_at IS NULL`,
checking `meta.changes`) instead of read-then-write checks. See
`docs/superpowers/specs/2026-07-23-workspace-delete-lock-design.md` (also
revised) for the full design rationale.

## Global Constraints

- D1 is authoritative for access decisions; auth enforcement happens at the API level (`AGENTS.md`, `CLAUDE.md`).
- Never modify D1 schema without an ADR under `DECISIONS/` (`AGENTS.md` §5.3 / `CLAUDE.md`).
- All `wrangler d1 execute` targets `--remote` — no local/staging D1 for this project (not exercised in this plan; no live migration is run against production here).
- Test before deploy — Worker deploys are instant and affect production immediately.
- Never deploy secrets — not applicable to this change.
- `main` requires a PR — no direct pushes, including from admins. This plan continues on the existing branch `claude/unruffled-hugle-f541e9` / PR [#40](https://github.com/remeadows/warsignallabs-site/pull/40), which already carries the approved design spec.
- Full verification standard for this repo, run from `portal-app/`: `npm test`, `npm run lint`, `npm run build`, and from `portal-app/worker/`: `npx wrangler deploy --dry-run`.
- Design spec: `docs/superpowers/specs/2026-07-23-workspace-delete-lock-design.md` — this plan implements it exactly; no TTL/self-heal for a stuck lock (explicitly decided against per that spec).
- `INSERT ... SELECT ... WHERE EXISTS (...)` and `UPDATE ... WHERE ... AND deleting_at IS NULL` are confirmed to behave as intended against `node:sqlite`'s `DatabaseSync` (the engine `createTestDb()` uses): a passing guard yields `changes: 1` and a real row change; a failing guard yields `changes: 0` and no row change. Verified directly before writing this plan — see the note in Task 2 Step 3.

---

### Task 1: Migration + ADR for the `deleting_at` lock column

**Files:**
- Create: `portal-app/worker/migrations/008_workspace_deletion_lock.sql`
- Create: `DECISIONS/0005-workspace-deletion-lock.md`

**Interfaces:**
- Produces: a `deleting_at TEXT` column (nullable) on `workspaces`, consumed by Task 2 and Task 3.

- [ ] **Step 1: Write the migration**

Create `portal-app/worker/migrations/008_workspace_deletion_lock.sql`:

```sql
-- 008_workspace_deletion_lock.sql — workspace-deletion lock, closing the
-- upload/replace-vs-delete race that can orphan an R2 object with no
-- surviving D1 file row (CodeRabbit finding on PR #37; documented as a known
-- limitation in DECISIONS/0004-phase3-comments-schema.md and inline at the
-- R2 SELECT in workspaces.js). See DECISIONS/0005 for the full design.
--
-- Nullable timestamp, not a boolean: NULL means "not being deleted"; a value
-- is the moment handleDeleteWorkspace claimed the lock. Additive ADD COLUMN
-- — no rebuild, mirrors the comments.deleted_at soft-marker convention
-- already in this schema (007_comments_notifications.sql).
ALTER TABLE workspaces ADD COLUMN deleting_at TEXT;
```

- [ ] **Step 2: Verify the migration applies cleanly against every prior migration**

Run:

```bash
rm -f /tmp/workspace-lock-check.db
for migration in "portal-app/worker/migrations"/*.sql; do
  sqlite3 /tmp/workspace-lock-check.db < "$migration"
done
sqlite3 /tmp/workspace-lock-check.db ".schema workspaces" | grep deleting_at
rm -f /tmp/workspace-lock-check.db
```

Expected: the `grep` prints `  deleting_at TEXT,` (or equivalent) — confirming the column exists and every migration file, including this one, applied without error.

- [ ] **Step 3: Write the ADR**

Create `DECISIONS/0005-workspace-deletion-lock.md`:

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add portal-app/worker/migrations/008_workspace_deletion_lock.sql DECISIONS/0005-workspace-deletion-lock.md
git commit -m "$(cat <<'EOF'
feat(portal): add workspace-deletion lock column + ADR

Additive deleting_at column on workspaces. Enforcement (atomic guarded
writes, per ADR-0005 after PR #40 review corrected the initial read-based
design) lands in the next commits; this is schema + design record only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `assertWorkspaceNotDeleting` + atomic lock claim/clear in `handleDeleteWorkspace`

**Files:**
- Modify: `portal-app/worker/src/routes/workspaces.js:229-269` (`handleDeleteWorkspace`)
- Modify: `portal-app/worker/src/routes/workspaces.test.js`

**Interfaces:**
- Consumes: `deleting_at` column from Task 1.
- Produces: `export function assertWorkspaceNotDeleting(workspace)` — throws `Response` (409) if `workspace.deleting_at` is truthy, otherwise returns `undefined`. Fast-path only; consumed by Task 3, which also needs the atomic-guarded-write pattern demonstrated here.

- [ ] **Step 1: Write the failing tests**

In `portal-app/worker/src/routes/workspaces.test.js`, add a new `it(...)` for the atomic lock-acquisition guarantee, a new `it(...)` for the fast-path double-delete check, a new `it(...)` for R2-delete-failure aggregation, and extend the existing failure test. The full updated file:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { handleDeleteWorkspace } from './workspaces.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

// Real in-memory SQLite with the actual migration files applied, so foreign-key
// enforcement matches production D1 — string-matching a mocked prepare() can't
// catch a missing child-table cleanup, which is exactly the bug class this file
// exists to cover.
function createTestDb() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
  }
  // 005 switches foreign_keys off mid-rebuild; D1 re-enables it per session.
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

// Minimal D1 adapter over node:sqlite — the prepare/bind/first/all/run/batch
// surface the route handlers use. batch() mirrors D1's contract: statements run
// in an implicit transaction, and any failure rolls back the whole batch.
function d1(db) {
  const statement = (sql, params) => ({
    sql,
    params,
    bind: (...args) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true }),
    run: async () => ({ success: true, meta: db.prepare(sql).run(...params) }),
  })
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      db.exec('BEGIN')
      try {
        const results = statements.map((s) => ({ success: true, meta: db.prepare(s.sql).run(...s.params) }))
        db.exec('COMMIT')
        return results
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

describe('handleDeleteWorkspace', () => {
  let db, env
  const admin = { userId: 'clerk_admin', dbUserId: 'usr-admin', role: 'admin' }
  const request = new Request('https://api.test/api/workspaces/acme', { method: 'DELETE' })

  beforeEach(() => {
    db = createTestDb()
    env = { DB: d1(db), FILES: { delete: async () => {} } }
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES ('usr-admin', 'russ', 'russ@test.dev', 'admin')",
    ).run()
    db.prepare(
      "INSERT INTO workspaces (id, name, slug) VALUES ('ws-1', 'Acme', 'acme')",
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  const insertNotification = () =>
    db.prepare(
      `INSERT INTO notifications (id, event_type, workspace_id, recipient_email, subject, body_text)
       VALUES ('ntf-1', 'file.uploaded', 'ws-1', 'client@test.dev', 'New file', 'A file was uploaded')`,
    ).run()

  it('claims the deletion lock atomically: only the first of two concurrent claims succeeds', () => {
    // Direct DB-level test of the guard itself, not the handler — this is
    // what actually proves the double-delete race is closed. Two async
    // handler calls in a single-threaded test process can't produce genuine
    // concurrent statement execution, so simulating that would only test
    // our test double, not the real guarantee. The guarantee holds because
    // SQLite serializes statement execution: whichever of two callers'
    // conditional UPDATEs runs second sees the first one's committed write
    // and its WHERE clause no longer matches, regardless of what either
    // caller read beforehand (ADR-0005).
    const claim = () => db.prepare(
      "UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1' AND deleting_at IS NULL",
    ).run()

    const first = claim()
    const second = claim()

    expect(first.changes).toBe(1)
    expect(second.changes).toBe(0)
  })

  it('deletes a workspace that has email-notification history, preserving the send log detached', async () => {
    // Phase 1's sendEmail() writes a workspace-scoped row to `notifications`
    // (the Resend send log) — its workspace_id FK has no ON DELETE clause.
    insertNotification()

    const res = await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })

    expect(res.status).toBe(200)
    const ws = db.prepare("SELECT id FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws).toBeUndefined()
    // Email audit trail survives, detached — same reasoning as audit_log's
    // ON DELETE SET NULL in 007 (ADR-0004).
    const ntf = db.prepare("SELECT workspace_id FROM notifications WHERE id = 'ntf-1'").get()
    expect(ntf).toBeDefined()
    expect(ntf.workspace_id).toBeNull()
  })

  it('rolls back every mutation when the workspace delete itself fails, including the deletion lock', async () => {
    insertNotification()
    // A test-only FK the handler doesn't know about, standing in for any
    // child-table gap (folders and file_versions were real ones): the final
    // DELETE FROM workspaces must fail, and when it does, NOTHING may have
    // committed — a partial run would permanently detach the send log from a
    // workspace that still exists.
    db.exec(`CREATE TABLE test_blocker (id TEXT PRIMARY KEY,
             workspace_id TEXT NOT NULL REFERENCES workspaces(id))`)
    db.prepare("INSERT INTO test_blocker (id, workspace_id) VALUES ('blk-1', 'ws-1')").run()

    await expect(handleDeleteWorkspace(request, env, admin, { slug: 'acme' })).rejects.toThrow()

    const ws = db.prepare("SELECT id, deleting_at FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws).toBeDefined()
    // The lock write commits outside the failed batch (ADR-0005) — it must
    // be explicitly cleared on failure, or the workspace stays locked out of
    // future uploads forever with no path to recovery.
    expect(ws.deleting_at).toBeNull()
    const ntf = db.prepare("SELECT workspace_id FROM notifications WHERE id = 'ntf-1'").get()
    expect(ntf.workspace_id).toBe('ws-1')
  })

  it('aborts before the D1 batch and clears the lock when an R2 delete fails, instead of orphaning the object', async () => {
    db.prepare(
      `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
       VALUES ('file-1', 'ws-1', 'documents', 'notes.txt', 'ws-1/documents/file-1_notes.txt', 11, 'text/plain', 'usr-admin', datetime('now'))`,
    ).run()
    env.FILES = { delete: async () => { throw new Error('R2 unavailable') } }

    await expect(handleDeleteWorkspace(request, env, admin, { slug: 'acme' })).rejects.toThrow()

    // The D1 batch never ran — the file row (and the real R2 object it
    // still points at) survives for a retried deletion, rather than the row
    // being removed while the R2 delete that was supposed to precede it
    // failed (ADR-0005, Decision 4).
    const file = db.prepare("SELECT id FROM files WHERE id = 'file-1'").get()
    expect(file).toBeDefined()
    const ws = db.prepare("SELECT deleting_at FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws.deleting_at).toBeNull()
  })

  it('rejects a second delete attempt on a workspace already mid-deletion (fast path)', async () => {
    db.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1'").run()

    let caught
    try {
      await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Response)
    expect(caught.status).toBe(409)
    const ws = db.prepare("SELECT id, deleting_at FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws).toBeDefined()
    expect(ws.deleting_at).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `cd "portal-app" && npx vitest run worker/src/routes/workspaces.test.js`

Expected:
- The direct atomic-guard test (`claims the deletion lock atomically...`) already passes — it exercises raw SQL against `node:sqlite` directly, not the handler, and this behavior was verified by hand before writing this plan (see Global Constraints). It's included here as a permanent regression test, not because it's currently failing.
- "rolls back every mutation..." fails on the new `expect(ws.deleting_at).toBeNull()` assertion (`ws.deleting_at` is `undefined`, since nothing currently manages that column).
- "aborts before the D1 batch..." fails: `handleDeleteWorkspace` currently swallows the R2 delete error and proceeds to run the D1 batch anyway, so the file row is gone (`file` is `undefined`) instead of surviving.
- "rejects a second delete attempt..." fails: nothing currently checks `deleting_at`, so the delete proceeds and `caught` is `undefined`.

- [ ] **Step 3: Implement the atomic lock claim/clear and R2-failure aggregation in `handleDeleteWorkspace`**

Verified directly against `node:sqlite` (the same engine `createTestDb()` uses) before writing this step:

```js
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, locked TEXT)')
db.exec("INSERT INTO t VALUES ('a', NULL)")
db.prepare("UPDATE t SET locked = 'x' WHERE id = 'a' AND locked IS NULL").run()
// => { changes: 1, lastInsertRowid: 1 }
db.prepare("UPDATE t SET locked = 'y' WHERE id = 'a' AND locked IS NULL").run()
// => { changes: 0, lastInsertRowid: 1 }  -- second claim correctly no-ops
```

In `portal-app/worker/src/routes/workspaces.js`, replace the existing `handleDeleteWorkspace` function (currently lines 229-269):

```js
/**
 * DELETE /api/workspaces/:slug — admin only, deletes workspace + files + assignments
 */
export async function handleDeleteWorkspace(request, env, user, params) {
  requireRole(user, 'admin')

  const workspace = await env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  // Delete files from R2
  const files = await env.DB.prepare('SELECT r2_key FROM files WHERE workspace_id = ?')
    .bind(workspace.id).all()
  for (const f of files.results) {
    try { await env.FILES.delete(f.r2_key) } catch { /* continue */ }
  }

  // Delete D1 records: files, comments, invitations, user_workspaces, then
  // detach notifications, then delete the workspace. Each of these FKs has no
  // cascade (ADR-0004), so a workspace with any comment, invitation, or email
  // history would otherwise fail this delete with a foreign-key error.
  // notifications (the Phase 1 email send log) is detached, not deleted — the
  // send history must survive workspace deletion, same reasoning as
  // audit_log.workspace_id ON DELETE SET NULL (ADR-0004).
  // One atomic batch: if any statement fails (e.g. an unhandled child-table
  // FK), nothing commits — sequential .run() calls would leave the send log
  // permanently detached from a workspace that still exists.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM files WHERE workspace_id = ?').bind(workspace.id),
    env.DB.prepare('DELETE FROM comments WHERE workspace_id = ?').bind(workspace.id),
    env.DB.prepare('DELETE FROM invitations WHERE workspace_id = ?').bind(workspace.id),
    env.DB.prepare('DELETE FROM user_workspaces WHERE workspace_id = ?').bind(workspace.id),
    env.DB.prepare('UPDATE notifications SET workspace_id = NULL WHERE workspace_id = ?').bind(workspace.id),
    env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspace.id),
  ])

  await logAudit(env, user.userId, 'workspace.delete', {
    resourceType: 'workspace', resourceId: workspace.id,
    name: workspace.name, slug: workspace.slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace deleted', slug: params.slug })
}
```

with:

```js
/**
 * Fast-path guard against a write racing an in-flight workspace deletion.
 * This reads a previously-fetched `workspace`/`file` row, so it rejects the
 * common case (a workspace already known to be locked) cheaply and early —
 * it is NOT the correctness guarantee for the actual race, since the object
 * it checks can go stale between this call and a later write. The atomic
 * guarded writes in handleDeleteWorkspace/handleUploadFile/handleReplaceFile
 * are what close the race itself (ADR-0005).
 */
export function assertWorkspaceNotDeleting(workspace) {
  if (workspace?.deleting_at) {
    throw errorResponse('Workspace is being deleted', 409)
  }
}

/**
 * DELETE /api/workspaces/:slug — admin only, deletes workspace + files + assignments
 */
export async function handleDeleteWorkspace(request, env, user, params) {
  requireRole(user, 'admin')

  const workspace = await env.DB.prepare('SELECT id, name, slug, deleting_at FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)
  assertWorkspaceNotDeleting(workspace)

  // Claim the deletion lock atomically: the WHERE clause re-checks
  // deleting_at at write time, not at the time `workspace` above was read.
  // Two concurrent deletes can both pass the fast-path check above (both
  // read deleting_at = NULL before either writes) — this conditional UPDATE
  // is what actually closes the race, since SQLite serializes statement
  // execution and only one caller's UPDATE can still match a row where
  // deleting_at IS NULL (ADR-0005).
  const lockResult = await env.DB.prepare(
    "UPDATE workspaces SET deleting_at = datetime('now') WHERE id = ? AND deleting_at IS NULL",
  ).bind(workspace.id).run()
  if (lockResult.meta.changes === 0) {
    return errorResponse('Workspace is being deleted', 409)
  }

  try {
    // Delete files from R2. Aggregate failures instead of swallowing them —
    // if any R2 object can't be deleted, the D1 batch below must not run, or
    // the only record of that R2 key would be removed while the object
    // itself still exists, orphaning it the same way the upload/replace race
    // does (ADR-0005).
    const files = await env.DB.prepare('SELECT r2_key FROM files WHERE workspace_id = ?')
      .bind(workspace.id).all()
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

    // Delete D1 records: files, comments, invitations, user_workspaces, then
    // detach notifications, then delete the workspace. Each of these FKs has no
    // cascade (ADR-0004), so a workspace with any comment, invitation, or email
    // history would otherwise fail this delete with a foreign-key error.
    // notifications (the Phase 1 email send log) is detached, not deleted — the
    // send history must survive workspace deletion, same reasoning as
    // audit_log.workspace_id ON DELETE SET NULL (ADR-0004).
    // One atomic batch: if any statement fails (e.g. an unhandled child-table
    // FK), nothing commits — sequential .run() calls would leave the send log
    // permanently detached from a workspace that still exists.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM files WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM comments WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM invitations WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM user_workspaces WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('UPDATE notifications SET workspace_id = NULL WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspace.id),
    ])
  } catch (err) {
    // The lock write above already committed outside this try block — a
    // failed R2 loop (including the aggregated-failure throw above) or a
    // failed batch must not leave the workspace permanently locked out of
    // future uploads (ADR-0005).
    await env.DB.prepare('UPDATE workspaces SET deleting_at = NULL WHERE id = ?')
      .bind(workspace.id).run()
    throw err
  }

  await logAudit(env, user.userId, 'workspace.delete', {
    resourceType: 'workspace', resourceId: workspace.id,
    name: workspace.name, slug: workspace.slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace deleted', slug: params.slug })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "portal-app" && npx vitest run worker/src/routes/workspaces.test.js`

Expected: all 5 tests in `handleDeleteWorkspace` pass.

- [ ] **Step 5: Commit**

```bash
git add portal-app/worker/src/routes/workspaces.js portal-app/worker/src/routes/workspaces.test.js
git commit -m "$(cat <<'EOF'
feat(portal): atomic lock claim/clear + R2-failure aggregation in handleDeleteWorkspace

Replaces the unconditional lock UPDATE with a conditional one (WHERE
deleting_at IS NULL, checked via meta.changes) so two concurrent deletes
can't both proceed — the read-based assertWorkspaceNotDeleting() check alone
couldn't guarantee that (PR #40 review). Also aggregates R2 delete-loop
failures instead of swallowing them, aborting before the D1 batch runs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Atomic guarded writes in `handleUploadFile` and `handleReplaceFile`

**Files:**
- Modify: `portal-app/worker/src/routes/files.js:1-5` (imports), `:103-238` (`handleUploadFile`), `:246-365` (`handleReplaceFile`)
- Create: `portal-app/worker/src/routes/files.test.js`

**Interfaces:**
- Consumes: `assertWorkspaceNotDeleting(workspace)` from Task 2 (`./workspaces.js`), used as a fast-path check only.

- [ ] **Step 1: Write the failing tests**

Create `portal-app/worker/src/routes/files.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { handleUploadFile, handleReplaceFile } from './files.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

// Real in-memory SQLite with the actual migration files applied — see
// workspaces.test.js for why this suite doesn't mock the DB.
function createTestDb() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'))
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function d1(db) {
  const statement = (sql, params) => ({
    sql,
    params,
    bind: (...args) => statement(sql, args),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true }),
    run: async () => ({ success: true, meta: db.prepare(sql).run(...params) }),
  })
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      db.exec('BEGIN')
      try {
        const results = statements.map((s) => ({ success: true, meta: db.prepare(s.sql).run(...s.params) }))
        db.exec('COMMIT')
        return results
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

// Minimal R2 stand-in — the handlers only put/delete by key, never read back.
// Exposes the underlying store so tests can assert an object was (or was
// not) rolled back without needing to predict the generated key.
function makeFilesBucket() {
  const store = new Map()
  return {
    put: async (key, _stream, opts) => { store.set(key, opts) },
    delete: async (key) => { store.delete(key) },
    _store: store,
  }
}

const writer = {
  userId: 'clerk_writer',
  dbUserId: 'usr-writer',
  role: 'owner',
  workspaceSlugs: ['acme'],
  workspacePermissions: { acme: 'write' },
  email: 'sam@test.dev',
}

function makeUploadRequest(content, filename, mimeType) {
  const formData = new FormData()
  formData.set('file', new File([content], filename, { type: mimeType }))
  formData.set('category', 'documents')
  return new Request('https://api.test/api/workspaces/acme/files', { method: 'POST', body: formData })
}

function makeReplaceRequest(content, filename, mimeType) {
  const formData = new FormData()
  formData.set('file', new File([content], filename, { type: mimeType }))
  return new Request('https://api.test/api/files/file-1', { method: 'PUT', body: formData })
}

describe('handleUploadFile', () => {
  let db, env

  beforeEach(() => {
    db = createTestDb()
    env = { DB: d1(db), FILES: makeFilesBucket() }
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES ('usr-writer', 'sam', 'sam@test.dev', 'owner')",
    ).run()
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-1', 'Acme', 'acme')").run()
  })

  afterEach(() => {
    db.close()
  })

  it('uploads a file when the workspace is not being deleted', async () => {
    const request = makeUploadRequest('hello world', 'notes.txt', 'text/plain')

    const res = await handleUploadFile(request, env, writer, { slug: 'acme' }, {})

    expect(res.status).toBe(201)
    const file = db.prepare("SELECT id FROM files WHERE workspace_id = 'ws-1'").get()
    expect(file).toBeDefined()
    expect(env.FILES._store.size).toBe(1)
  })

  it('rejects an upload with 409 (fast path) when the workspace is already locked at request start', async () => {
    db.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1'").run()
    const request = makeUploadRequest('hello world', 'notes.txt', 'text/plain')

    let caught
    try {
      await handleUploadFile(request, env, writer, { slug: 'acme' }, {})
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Response)
    expect(caught.status).toBe(409)
    const file = db.prepare("SELECT id FROM files WHERE workspace_id = 'ws-1'").get()
    expect(file).toBeUndefined()
    expect(env.FILES._store.size).toBe(0)
  })

  it('rejects with 409 and rolls back the R2 object when the workspace is locked during the upload (a race the fast path cannot see)', async () => {
    // The fast-path check above reads the workspace before the R2 put, which
    // takes real time in production. This simulates "a concurrent
    // handleDeleteWorkspace claims the lock while this upload's R2 write is
    // in flight" by flipping deleting_at as a side effect of put() itself —
    // deterministic, and exercising exactly the window the fast-path check
    // cannot close (ADR-0005). The guarded INSERT is what must catch this.
    const baseBucket = makeFilesBucket()
    env.FILES = {
      put: async (key, stream, opts) => {
        db.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1'").run()
        return baseBucket.put(key, stream, opts)
      },
      delete: baseBucket.delete,
      _store: baseBucket._store,
    }
    const request = makeUploadRequest('hello world', 'notes.txt', 'text/plain')

    const res = await handleUploadFile(request, env, writer, { slug: 'acme' }, {})

    expect(res.status).toBe(409)
    const file = db.prepare("SELECT id FROM files WHERE workspace_id = 'ws-1'").get()
    expect(file).toBeUndefined()
    // The R2 object the handler wrote before losing the race was rolled back.
    expect(env.FILES._store.size).toBe(0)
  })
})

describe('handleReplaceFile', () => {
  let db, env

  beforeEach(() => {
    db = createTestDb()
    env = { DB: d1(db), FILES: makeFilesBucket() }
    db.prepare(
      "INSERT INTO users (id, username, email, role) VALUES ('usr-writer', 'sam', 'sam@test.dev', 'owner')",
    ).run()
    db.prepare("INSERT INTO workspaces (id, name, slug) VALUES ('ws-1', 'Acme', 'acme')").run()
    db.prepare(
      `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
       VALUES ('file-1', 'ws-1', 'documents', 'notes.txt', 'ws-1/documents/file-1_notes.txt', 11, 'text/plain', 'usr-writer', datetime('now'))`,
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  it('replaces a file when the workspace is not being deleted', async () => {
    const request = makeReplaceRequest('updated content', 'notes.txt', 'text/plain')

    const res = await handleReplaceFile(request, env, writer, { id: 'file-1' }, {})

    expect(res.status).toBe(200)
    const file = db.prepare("SELECT version, r2_key FROM files WHERE id = 'file-1'").get()
    expect(file.version).toBe(2)
    expect(env.FILES._store.has(file.r2_key)).toBe(true)
  })

  it('rejects a replace with 409 (fast path) when the workspace is already locked at request start', async () => {
    db.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1'").run()
    const request = makeReplaceRequest('updated content', 'notes.txt', 'text/plain')

    let caught
    try {
      await handleReplaceFile(request, env, writer, { id: 'file-1' }, {})
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Response)
    expect(caught.status).toBe(409)
    const file = db.prepare("SELECT version FROM files WHERE id = 'file-1'").get()
    expect(file.version).toBe(1)
    expect(env.FILES._store.size).toBe(0)
  })

  it('rejects with 409 and rolls back the new-version R2 object when the workspace is locked during the replace', async () => {
    // Same injection technique as the upload test above — flips deleting_at
    // as a side effect of the R2 put for the new version, simulating a
    // concurrent delete claiming the lock during that window.
    const baseBucket = makeFilesBucket()
    env.FILES = {
      put: async (key, stream, opts) => {
        db.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1'").run()
        return baseBucket.put(key, stream, opts)
      },
      delete: baseBucket.delete,
      _store: baseBucket._store,
    }
    const request = makeReplaceRequest('updated content', 'notes.txt', 'text/plain')

    const res = await handleReplaceFile(request, env, writer, { id: 'file-1' }, {})

    expect(res.status).toBe(409)
    const file = db.prepare("SELECT version, r2_key FROM files WHERE id = 'file-1'").get()
    expect(file.version).toBe(1)
    expect(file.r2_key).toBe('ws-1/documents/file-1_notes.txt')
    // The new-version R2 object the handler wrote before losing the race
    // was rolled back — nothing survives in the bucket.
    expect(env.FILES._store.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd "portal-app" && npx vitest run worker/src/routes/files.test.js`

Expected: the "already locked at request start" tests fail (nothing checks `deleting_at` yet, so the upload/replace succeeds instead of being rejected). The "locked during the upload/replace" race-injection tests also fail — the write succeeds unconditionally, so `res.status` is `201`/`200` instead of `409`, and the R2 store isn't rolled back. The two "not being deleted" tests should already pass — confirming the harness itself (including the new `_store` bucket introspection) is correct before the guard is added.

- [ ] **Step 3: Implement the guards in `files.js`**

In `portal-app/worker/src/routes/files.js`, update the import block (currently lines 1-5):

```js
// worker/src/routes/files.js
import { jsonResponse, errorResponse, CORS_HEADERS, SECURITY_HEADERS } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, checkStorageThreshold, escapeHtml } from '../notify.js'
```

to:

```js
// worker/src/routes/files.js
import { jsonResponse, errorResponse, CORS_HEADERS, SECURITY_HEADERS } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, checkStorageThreshold, escapeHtml } from '../notify.js'
import { assertWorkspaceNotDeleting } from './workspaces.js'
```

In `handleUploadFile`, replace:

```js
  const workspace = await env.DB.prepare(
    'SELECT id FROM workspaces WHERE slug = ?',
  )
    .bind(params.slug)
    .first()

  if (!workspace) {
    return errorResponse('Workspace not found', 404)
  }
```

with:

```js
  const workspace = await env.DB.prepare(
    'SELECT id, deleting_at FROM workspaces WHERE slug = ?',
  )
    .bind(params.slug)
    .first()

  if (!workspace) {
    return errorResponse('Workspace not found', 404)
  }
  assertWorkspaceNotDeleting(workspace)
```

Then, further down `handleUploadFile`, replace the R2 upload + D1 insert block:

```js
  // Upload to R2
  await env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: params.slug,
      originalFilename: sanitized,
    },
  })

  // Use dbUserId for the foreign key, fall back to clerk ID
  const uploadedBy = user.dbUserId || user.userId

  // Record in D1
  await env.DB.prepare(
    `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(fileId, workspace.id, category, sanitized, r2Key, file.size, file.type, uploadedBy, folderId)
    .run()
```

with:

```js
  // Upload to R2
  await env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: params.slug,
      originalFilename: sanitized,
    },
  })

  // Use dbUserId for the foreign key, fall back to clerk ID
  const uploadedBy = user.dbUserId || user.userId

  // Record in D1 — atomically guarded: the R2 put above takes real time, and
  // the fast-path assertWorkspaceNotDeleting check above read a snapshot
  // from before that put, so it cannot by itself catch a concurrent
  // handleDeleteWorkspace that claims the lock during the upload. This
  // INSERT is a no-op if that happened, since SQLite evaluates the WHERE
  // EXISTS clause and the write in one atomic statement (ADR-0005).
  const insertResult = await env.DB.prepare(
    `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, folder_id, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
     WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND deleting_at IS NULL)`,
  )
    .bind(fileId, workspace.id, category, sanitized, r2Key, file.size, file.type, uploadedBy, folderId, workspace.id)
    .run()

  if (insertResult.meta.changes === 0) {
    // Lost the race: the workspace was locked between the fast-path check
    // and this write. Roll back the R2 object just written so it isn't left
    // with no D1 reference — the exact orphan this design prevents.
    try { await env.FILES.delete(r2Key) } catch { /* best effort */ }
    return errorResponse('Workspace is being deleted', 409)
  }
```

In `handleReplaceFile`, replace:

```js
  // Fetch existing file + workspace info
  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category,
            f.workspace_id, f.version, f.uploaded_by, w.slug AS workspace_slug, w.name AS workspace_name
     FROM files f
     INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(fileId).first()

  if (!file) return errorResponse('File not found', 404)

  // Check workspace write permission
  if (!hasWorkspaceWriteAccess(user, file.workspace_slug)) {
    throw errorResponse('Forbidden: you need write permission on this workspace to replace files', 403)
  }
```

with:

```js
  // Fetch existing file + workspace info
  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category,
            f.workspace_id, f.version, f.uploaded_by, w.slug AS workspace_slug, w.name AS workspace_name,
            w.deleting_at
     FROM files f
     INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(fileId).first()

  if (!file) return errorResponse('File not found', 404)

  // Check workspace write permission
  if (!hasWorkspaceWriteAccess(user, file.workspace_slug)) {
    throw errorResponse('Forbidden: you need write permission on this workspace to replace files', 403)
  }
  assertWorkspaceNotDeleting(file)
```

(`assertWorkspaceNotDeleting` only reads a `.deleting_at` property off whatever object it's given — the `file` row here has it via the `w.deleting_at` join column, no aliasing needed.)

Then, further down `handleReplaceFile`, replace the archive/upload/update block:

```js
  const newVersion = (file.version || 1) + 1

  // 1. Archive current version to file_versions
  const versionId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).bind(
    versionId, fileId, file.version || 1, file.r2_key,
    file.size_bytes, file.content_type, file.uploaded_by,
  ).run()

  // 2. Upload new file to R2 with new key
  const sanitized = (newFile.name || file.filename).replace(/[/\\]/g, '_').slice(0, 200)
  const newR2Key = `${file.workspace_id}/${file.category}/${fileId}_v${newVersion}_${sanitized}`

  await env.FILES.put(newR2Key, newFile.stream(), {
    httpMetadata: { contentType: newFile.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: file.workspace_slug,
      originalFilename: sanitized,
      version: String(newVersion),
    },
  })

  // 3. Update files record — new r2_key, size, content_type, version, filename
  const uploadedBy = user.dbUserId || user.userId
  await env.DB.prepare(
    `UPDATE files SET r2_key = ?, size_bytes = ?, content_type = ?, filename = ?,
            version = ?, uploaded_by = ?, created_at = datetime('now')
     WHERE id = ?`,
  ).bind(newR2Key, newFile.size, newFile.type, sanitized, newVersion, uploadedBy, fileId).run()

  // 4. Optionally delete old R2 object (keep for now — archived versions remain accessible)
  // Old R2 key preserved in file_versions for rollback capability
```

with:

```js
  const newVersion = (file.version || 1) + 1

  // 1. Archive current version to file_versions — atomically guarded: a
  // cheap early exit (before any R2 traffic) in the common case where the
  // workspace was already locked before this request started.
  const versionId = crypto.randomUUID()
  const archiveResult = await env.DB.prepare(
    `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now')
     WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND deleting_at IS NULL)`,
  ).bind(
    versionId, fileId, file.version || 1, file.r2_key,
    file.size_bytes, file.content_type, file.uploaded_by, file.workspace_id,
  ).run()

  if (archiveResult.meta.changes === 0) {
    return errorResponse('Workspace is being deleted', 409)
  }

  // 2. Upload new file to R2 with new key
  const sanitized = (newFile.name || file.filename).replace(/[/\\]/g, '_').slice(0, 200)
  const newR2Key = `${file.workspace_id}/${file.category}/${fileId}_v${newVersion}_${sanitized}`

  await env.FILES.put(newR2Key, newFile.stream(), {
    httpMetadata: { contentType: newFile.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: file.workspace_slug,
      originalFilename: sanitized,
      version: String(newVersion),
    },
  })

  // 3. Update files record — new r2_key, size, content_type, version,
  // filename. Atomically guarded again: this is the true gate, since it's
  // what makes the new r2_key discoverable at all. If the workspace was
  // locked in the moment between step 1 and this R2 put, roll back the new
  // object — the archive row from step 1 is left in place; it accurately
  // records the pre-replace version and doesn't become incorrect just
  // because this replace didn't ultimately commit (ADR-0005).
  const uploadedBy = user.dbUserId || user.userId
  const updateResult = await env.DB.prepare(
    `UPDATE files SET r2_key = ?, size_bytes = ?, content_type = ?, filename = ?,
            version = ?, uploaded_by = ?, created_at = datetime('now')
     WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE deleting_at IS NULL)`,
  ).bind(newR2Key, newFile.size, newFile.type, sanitized, newVersion, uploadedBy, fileId).run()

  if (updateResult.meta.changes === 0) {
    try { await env.FILES.delete(newR2Key) } catch { /* best effort */ }
    return errorResponse('Workspace is being deleted', 409)
  }

  // 4. Optionally delete old R2 object (keep for now — archived versions remain accessible)
  // Old R2 key preserved in file_versions for rollback capability
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "portal-app" && npx vitest run worker/src/routes/files.test.js`

Expected: all 6 tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd "portal-app" && npm test`

Expected: all suites pass, including `workspaces.test.js` from Task 2.

- [ ] **Step 6: Commit**

```bash
git add portal-app/worker/src/routes/files.js portal-app/worker/src/routes/files.test.js
git commit -m "$(cat <<'EOF'
feat(portal): atomic guarded writes for uploads/replaces on a locked workspace

handleUploadFile's file INSERT and handleReplaceFile's archive INSERT +
files UPDATE are now each conditioned (WHERE EXISTS .../ deleting_at IS
NULL) on the workspace not being locked, checked via meta.changes, with the
just-written R2 object rolled back on a lost race. The earlier read-based
assertWorkspaceNotDeleting() check alone couldn't close this — a concurrent
delete could still claim the lock during the R2 put (PR #40 review). New
files.test.js covers both the fast-path (already locked) and race-injection
(locked mid-request) cases for each handler.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full verification and PR update

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd "portal-app" && npm test`

Expected: all suites pass (0 failures).

- [ ] **Step 2: Run lint**

Run: `cd "portal-app" && npm run lint`

Expected: no errors. If lint reports issues in files touched by this plan, fix them and re-run.

- [ ] **Step 3: Run the build**

Run: `cd "portal-app" && npm run build`

Expected: build completes with no errors (this plan makes no frontend changes, so this mainly guards against an accidental syntax error breaking the shared build).

- [ ] **Step 4: Dry-run the Worker deploy**

Run: `cd "portal-app/worker" && npx wrangler deploy --dry-run`

Expected: dry-run succeeds with no errors. This does not deploy anything — per `CLAUDE.md`, an actual deploy (migration + `wrangler deploy`) is a separate, explicit step for Russ to request.

- [ ] **Step 5: Push and confirm the PR**

```bash
git push
gh pr view 40 --json url,title,state
```

Expected: PR #40 now carries the design spec (existing) plus the migration, ADR, and implementation commits from Tasks 1-3. Report the PR URL to Russ; do not merge or request review beyond what's already configured — that's his call per `AGENTS.md`.
