# Workspace-Deletion Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the race between `handleDeleteWorkspace`'s R2-key snapshot and an in-flight file upload/replace, so a workspace deletion can no longer orphan an R2 object with no surviving D1 reference.

**Architecture:** Add a nullable `deleting_at` timestamp column to `workspaces`. `handleDeleteWorkspace` claims it (its own committed write) before snapshotting R2 keys, and clears it if the deletion fails partway. `handleUploadFile` and `handleReplaceFile` reject with 409 via a shared `assertWorkspaceNotDeleting()` guard when the column is set.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest with `node:sqlite` running the real migration files (no mocked DB — this bug class is invisible to a mocked prepare()).

## Global Constraints

- D1 is authoritative for access decisions; auth enforcement happens at the API level (`AGENTS.md`, `CLAUDE.md`).
- Never modify D1 schema without an ADR under `DECISIONS/` (`AGENTS.md` §5.3 / `CLAUDE.md`).
- All `wrangler d1 execute` targets `--remote` — no local/staging D1 for this project (not exercised in this plan; no live migration is run against production here).
- Test before deploy — Worker deploys are instant and affect production immediately.
- Never deploy secrets — not applicable to this change.
- `main` requires a PR — no direct pushes, including from admins. This plan continues on the existing branch `claude/unruffled-hugle-f541e9` / PR [#40](https://github.com/remeadows/warsignallabs-site/pull/40), which already carries the approved design spec.
- Full verification standard for this repo, run from `portal-app/`: `npm test`, `npm run lint`, `npm run build`, and from `portal-app/worker/`: `npx wrangler deploy --dry-run`.
- Design spec: `docs/superpowers/specs/2026-07-23-workspace-delete-lock-design.md` — this plan implements it exactly; no TTL/self-heal for a stuck lock (explicitly decided against per that spec).

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

2. **The lock is claimed in its own committed write**, immediately after
   `handleDeleteWorkspace` fetches the workspace row and *before* the R2-key
   snapshot `SELECT`. It cannot be folded into the final D1 `batch()`
   alongside the other deletes, because the R2 delete loop (which can take a
   noticeable amount of time for a workspace with many files) runs *between*
   the lock write and that batch — the lock must be visible to concurrent
   requests for that whole window, not just during the final batch.

3. **Enforcement is a shared helper**, `assertWorkspaceNotDeleting(workspace)`
   in `workspaces.js`, throwing `errorResponse('Workspace is being deleted', 409)`
   when `workspace.deleting_at` is set. Used by `handleUploadFile` and
   `handleReplaceFile` (after their existing 404/authorization checks, so an
   unauthorized caller still gets 403 rather than leaking the workspace's
   deletion state), and by `handleDeleteWorkspace` itself to reject a second
   concurrent delete attempt on the same workspace.

4. **The lock is explicitly cleared on failure.** If the R2 delete loop or
   the final D1 batch throws (e.g. an unhandled child-table FK, the same
   class of failure already covered by the "rolls back every mutation when
   the workspace delete itself fails" test in `workspaces.test.js`),
   `handleDeleteWorkspace` runs `UPDATE workspaces SET deleting_at = NULL
   WHERE id = ?` before rethrowing. Without this, a failed delete would
   permanently lock the workspace out of future uploads, since the lock
   write already committed separately from the batch that failed.

5. **No stale-lock TTL / self-heal.** If the Worker process dies mid-deletion
   after the lock write but before the catch block can run (e.g. a hard
   CPU-limit kill), the workspace stays locked with no automatic recovery —
   clearing `deleting_at` would need a manual `UPDATE`. Considered and
   rejected a TTL-based self-heal (treat a `deleting_at` older than N minutes
   as abandoned): this is a narrow-window, non-urgent bug to begin with, and
   a manual one-line UPDATE is an acceptable fallback for an event this rare.
   Revisit if it ever actually happens in production.

## Consequences

### Positive
- Closes the actual race window CodeRabbit flagged: an upload/replace that
  arrives after the lock is claimed is rejected with 409 instead of
  orphaning an R2 object.
- No rebuild risk — the migration is a single additive `ADD COLUMN`.
- A failed delete no longer has a side effect (a stuck lock) beyond its own
  rollback.

### Negative / things to watch
- A process kill between the lock write and the catch block is an
  unrecoverable-without-manual-intervention edge case (see Decision 5).
  Accepted as out of scope.
- This closes the specific window described above; it does not add
  distributed-lock guarantees beyond what D1's single-writer semantics
  already provide.

## Verification

```bash
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

Additive deleting_at column on workspaces, claimed by handleDeleteWorkspace
before its R2-key snapshot. Closes the upload/replace-vs-delete race that
can orphan an R2 object (CodeRabbit finding on PR #37). Enforcement wiring
lands in the next commits; this is schema + design record only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `assertWorkspaceNotDeleting` + wire into `handleDeleteWorkspace`

**Files:**
- Modify: `portal-app/worker/src/routes/workspaces.js:229-269` (`handleDeleteWorkspace`)
- Modify: `portal-app/worker/src/routes/workspaces.test.js`

**Interfaces:**
- Consumes: `deleting_at` column from Task 1.
- Produces: `export function assertWorkspaceNotDeleting(workspace)` — throws `Response` (409) if `workspace.deleting_at` is truthy, otherwise returns `undefined`. Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

In `portal-app/worker/src/routes/workspaces.test.js`, add a new `import` and two new `it(...)` blocks inside the existing `describe('handleDeleteWorkspace', ...)`, and extend the existing failure test. The full updated file:

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

  it('rejects a second delete attempt on a workspace already mid-deletion', async () => {
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

Expected: the "rolls back every mutation..." test fails on the new `expect(ws.deleting_at).toBeNull()` assertion (column doesn't exist yet as a concept the handler manages — `ws.deleting_at` is `undefined`, not `null`, since nothing ever sets it). The "rejects a second delete attempt" test fails because `handleDeleteWorkspace` doesn't check `deleting_at` at all — it proceeds to actually delete the workspace, so `caught` is `undefined` and the final assertions on `ws` fail (row is gone).

- [ ] **Step 3: Implement `assertWorkspaceNotDeleting` and wire the lock into `handleDeleteWorkspace`**

In `portal-app/worker/src/routes/workspaces.js`, replace the existing `handleDeleteWorkspace` function (currently lines 229-269):

```js
/**
 * PATCH /api/workspaces/:slug — update workspace (workspace admin permission or global admin)
 */
```
(leave everything above `handleDeleteWorkspace` unchanged)

Replace this block:

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
 * Guards against a write racing an in-flight workspace deletion. `deleting_at`
 * is claimed by handleDeleteWorkspace before it snapshots R2 keys — without
 * this check, a file uploaded/replaced after that snapshot would be deleted
 * from D1 by the workspace-scoped DELETE but its R2 object would never be
 * found again (ADR-0005).
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

  // Claim the deletion lock in its own committed write, before the R2-key
  // snapshot below — any upload/replace that lands after this point is
  // rejected by assertWorkspaceNotDeleting instead of silently orphaning an
  // R2 object (ADR-0005). This can't be folded into the batch() below: the
  // R2 delete loop runs between this write and that batch, and the lock must
  // be visible to concurrent requests for that whole window.
  await env.DB.prepare("UPDATE workspaces SET deleting_at = datetime('now') WHERE id = ?")
    .bind(workspace.id).run()

  try {
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
  } catch (err) {
    // The lock write above already committed outside this try block — a
    // failed R2 loop or batch must not leave the workspace permanently
    // locked out of future uploads (ADR-0005).
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

Expected: all 3 tests in `handleDeleteWorkspace` pass.

- [ ] **Step 5: Commit**

```bash
git add portal-app/worker/src/routes/workspaces.js portal-app/worker/src/routes/workspaces.test.js
git commit -m "$(cat <<'EOF'
feat(portal): claim/clear workspace-deletion lock in handleDeleteWorkspace

Adds assertWorkspaceNotDeleting() and wires the deleting_at lock into
handleDeleteWorkspace: claimed before the R2-key snapshot, cleared on any
failure so a failed delete doesn't strand the workspace locked, and used to
reject a second concurrent delete attempt with 409. Files.js wiring is next.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the lock into `handleUploadFile` and `handleReplaceFile`

**Files:**
- Modify: `portal-app/worker/src/routes/files.js:1-5` (imports), `:103-121` (`handleUploadFile`), `:246-263` (`handleReplaceFile`)
- Create: `portal-app/worker/src/routes/files.test.js`

**Interfaces:**
- Consumes: `assertWorkspaceNotDeleting(workspace)` from Task 2 (`./workspaces.js`).

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
function makeFilesBucket() {
  const store = new Map()
  return {
    put: async (key, _stream, opts) => { store.set(key, opts) },
    delete: async (key) => { store.delete(key) },
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
  })

  it('rejects an upload with 409 while the workspace is mid-deletion', async () => {
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
    const file = db.prepare("SELECT version FROM files WHERE id = 'file-1'").get()
    expect(file.version).toBe(2)
  })

  it('rejects a replace with 409 while the workspace is mid-deletion', async () => {
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
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd "portal-app" && npx vitest run worker/src/routes/files.test.js`

Expected: both "rejects ... with 409 while the workspace is mid-deletion" tests fail — `caught` is `undefined` because nothing currently checks `deleting_at`, so the upload/replace succeeds instead of being rejected (the assertions on `caught` and on the DB state fail). The two "not being deleted" tests should already pass (they exercise unchanged behavior) — confirming the new test file's harness itself is correct before the guard is added.

- [ ] **Step 3: Implement the guard in `files.js`**

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

  let formData
  try {
    formData = await request.formData()
  } catch {
    return errorResponse('Invalid multipart form data', 400)
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

  let formData
  try {
    formData = await request.formData()
  } catch {
    return errorResponse('Invalid multipart form data', 400)
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "portal-app" && npx vitest run worker/src/routes/files.test.js`

Expected: all 4 tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd "portal-app" && npm test`

Expected: all suites pass, including `workspaces.test.js` from Task 2.

- [ ] **Step 6: Commit**

```bash
git add portal-app/worker/src/routes/files.js portal-app/worker/src/routes/files.test.js
git commit -m "$(cat <<'EOF'
feat(portal): reject uploads/replaces on a workspace mid-deletion (409)

handleUploadFile and handleReplaceFile now call assertWorkspaceNotDeleting()
after their existing 404/authorization checks, closing the race with
handleDeleteWorkspace's R2-key snapshot (ADR-0005). New files.test.js covers
both handlers with and without the lock set, using the same
real-migrations-in-SQLite pattern as workspaces.test.js.

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
