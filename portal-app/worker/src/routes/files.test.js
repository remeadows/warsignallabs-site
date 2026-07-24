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
