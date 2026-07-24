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

  it('rolls back every mutation when the workspace delete itself fails', async () => {
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

    const ws = db.prepare("SELECT id FROM workspaces WHERE id = 'ws-1'").get()
    expect(ws).toBeDefined()
    const ntf = db.prepare("SELECT workspace_id FROM notifications WHERE id = 'ntf-1'").get()
    expect(ntf.workspace_id).toBe('ws-1')
  })
})
