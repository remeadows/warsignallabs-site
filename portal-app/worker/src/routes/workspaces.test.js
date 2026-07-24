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
