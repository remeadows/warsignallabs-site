#!/usr/bin/env node
// Applies pending SQL files in worker/migrations/ (sorted by filename) to the
// remote wsl-portal D1 database, tracking applied migrations in
// schema_migrations. Idempotent: re-running with nothing new is a no-op.

import { execSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.resolve(__dirname, '..')
const migrationsDir = path.join(workerDir, 'migrations')
const DB_NAME = 'wsl-portal'

function runD1(args) {
  const cmd = `npx wrangler d1 execute ${DB_NAME} --remote ${args}`
  return execSync(cmd, { cwd: workerDir, encoding: 'utf8' })
}

function runD1Json(args) {
  const out = runD1(`${args} --json`)
  // wrangler prints banner lines before the JSON array; find the first '['
  const start = out.indexOf('[')
  return JSON.parse(out.slice(start))
}

function bootstrap() {
  console.log('Ensuring schema_migrations table exists...')
  runD1(`--command "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"`)
}

function getAppliedMigrations() {
  const result = runD1Json(`--command "SELECT name FROM schema_migrations"`)
  const rows = result[0]?.results || []
  return new Set(rows.map((r) => r.name))
}

function applyMigration(filename) {
  const filePath = path.join(migrationsDir, filename)
  console.log(`Applying ${filename}...`)
  runD1(`--file "${filePath}"`)
  const escapedName = filename.replace(/'/g, "''")
  runD1(`--command "INSERT INTO schema_migrations (name) VALUES ('${escapedName}')"`)
  console.log(`Applied ${filename}`)
}

function main() {
  bootstrap()
  const applied = getAppliedMigrations()
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('No migration files found in worker/migrations/.')
    return
  }

  let appliedCount = 0
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`)
      continue
    }
    applyMigration(file)
    appliedCount++
  }

  console.log(`Done. ${appliedCount} migration(s) applied, ${files.length - appliedCount} already up to date.`)
}

main()
