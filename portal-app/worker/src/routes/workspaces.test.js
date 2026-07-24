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
  let db, env, deletedR2Keys, r2DeleteCalls
  const admin = { userId: 'clerk_admin', dbUserId: 'usr-admin', role: 'admin' }
  const request = new Request('https://api.test/api/workspaces/acme', { method: 'DELETE' })

  beforeEach(() => {
    db = createTestDb()
    deletedR2Keys = []
    r2DeleteCalls = []
    // R2's binding accepts a single key or an array of up to 1000 keys.
    env = {
      DB: d1(db),
      FILES: {
        delete: async (keyOrKeys) => {
          r2DeleteCalls.push(keyOrKeys)
          deletedR2Keys.push(...(Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]))
        },
      },
    }
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
    // caller read beforehand (ADR-0006).
    const claim = () => db.prepare(
      "UPDATE workspaces SET deleting_at = datetime('now') WHERE id = 'ws-1' AND deleting_at IS NULL",
    ).run()

    const first = claim()
    const second = claim()

    expect(first.changes).toBe(1)
    expect(second.changes).toBe(0)
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

  it('deletes a workspace containing folders, including nested folders', async () => {
    // folders.workspace_id FK has no ON DELETE clause, and folders self-reference
    // via parent_folder_id — insert parent before child so a naive single DELETE
    // hits the parent row first while the child still references it.
    db.prepare(
      "INSERT INTO folders (id, workspace_id, name) VALUES ('fld-parent', 'ws-1', 'Reports')",
    ).run()
    db.prepare(
      `INSERT INTO folders (id, workspace_id, parent_folder_id, name)
       VALUES ('fld-child', 'ws-1', 'fld-parent', 'Q2')`,
    ).run()

    const res = await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })

    expect(res.status).toBe(200)
    expect(db.prepare("SELECT id FROM workspaces WHERE id = 'ws-1'").get()).toBeUndefined()
    // Folders are workspace content, not audit history — hard-deleted.
    expect(db.prepare("SELECT id FROM folders WHERE workspace_id = 'ws-1'").all()).toHaveLength(0)
  })

  it('deletes a workspace whose files have archived versions', async () => {
    // handleReplaceFile archives the prior version to file_versions
    // (file_id FK, no ON DELETE) — deleting `files` first would FK-fail.
    db.prepare(
      `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, version)
       VALUES ('file-1', 'ws-1', 'documents', 'report.pdf', 'ws-1/documents/file-1_v2_report.pdf', 200, 'application/pdf', 'usr-admin', 2)`,
    ).run()
    db.prepare(
      `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by)
       VALUES ('fv-1', 'file-1', 1, 'ws-1/documents/file-1_report.pdf', 100, 'application/pdf', 'usr-admin')`,
    ).run()

    const res = await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })

    expect(res.status).toBe(200)
    expect(db.prepare("SELECT id FROM workspaces WHERE id = 'ws-1'").get()).toBeUndefined()
    // Version history is workspace content, not audit history — hard-deleted.
    expect(db.prepare("SELECT id FROM file_versions WHERE id = 'fv-1'").get()).toBeUndefined()
    expect(db.prepare("SELECT id FROM files WHERE id = 'file-1'").get()).toBeUndefined()
  })

  it('deletes archived version objects from R2, not just current file objects', async () => {
    // handleReplaceFile keeps the old R2 object ("preserved in file_versions for
    // rollback") — on workspace hard-delete those archived objects must go too,
    // or they leak in R2 forever with no DB row pointing at them.
    db.prepare(
      `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, version)
       VALUES ('file-1', 'ws-1', 'documents', 'report.pdf', 'ws-1/documents/file-1_v2_report.pdf', 200, 'application/pdf', 'usr-admin', 2)`,
    ).run()
    db.prepare(
      `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by)
       VALUES ('fv-1', 'file-1', 1, 'ws-1/documents/file-1_report.pdf', 100, 'application/pdf', 'usr-admin')`,
    ).run()

    const res = await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })

    expect(res.status).toBe(200)
    expect(deletedR2Keys).toContain('ws-1/documents/file-1_v2_report.pdf')
    expect(deletedR2Keys).toContain('ws-1/documents/file-1_report.pdf')
    // Bulk-delete: one binding call (one subrequest) for the whole batch, not
    // one per key — a large workspace would otherwise exhaust the Worker's
    // subrequest allowance mid-loop.
    expect(r2DeleteCalls).toHaveLength(1)
    expect(Array.isArray(r2DeleteCalls[0])).toBe(true)
  })

  it('aborts with 500 and keeps all DB rows when R2 deletion fails', async () => {
    // If an R2 object can't be deleted (transient error), the DB rows are the
    // only record those keys exist — deleting them anyway would strand the
    // objects in R2 undiscoverably. The handler must fail before touching D1
    // so the admin can simply retry.
    db.prepare(
      `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, version)
       VALUES ('file-1', 'ws-1', 'documents', 'report.pdf', 'ws-1/documents/file-1_v2_report.pdf', 200, 'application/pdf', 'usr-admin', 2)`,
    ).run()
    db.prepare(
      `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by)
       VALUES ('fv-1', 'file-1', 1, 'ws-1/documents/file-1_report.pdf', 100, 'application/pdf', 'usr-admin')`,
    ).run()
    env.FILES.delete = async () => { throw new Error('R2 unavailable') }

    const res = await handleDeleteWorkspace(request, env, admin, { slug: 'acme' })

    expect(res.status).toBe(500)
    const ws = db.prepare("SELECT id, deleting_at FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws).toBeDefined()
    // The lock claimed before the R2 batch-delete must not be left set on
    // this failure path — a stuck lock would block every future upload to
    // this workspace even after storage recovers (ADR-0006).
    expect(ws.deleting_at).toBeNull()
    expect(db.prepare("SELECT id FROM files WHERE id = 'file-1'").get()).toBeDefined()
    expect(db.prepare("SELECT id FROM file_versions WHERE id = 'fv-1'").get()).toBeDefined()
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
    // The lock write commits outside the failed batch (ADR-0006) — it must
    // be explicitly cleared on failure, or the workspace stays locked out of
    // future uploads forever with no path to recovery.
    expect(ws.deleting_at).toBeNull()
    const ntf = db.prepare("SELECT workspace_id FROM notifications WHERE id = 'ntf-1'").get()
    expect(ntf.workspace_id).toBe('ws-1')
  })
})
