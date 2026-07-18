-- 001_schema_migrations.sql
-- Tracks which migration files have been applied. Bootstrapped separately
-- by migrate.js (idempotent CREATE TABLE IF NOT EXISTS) before any numbered
-- migration runs, so this file mainly documents the table for readers.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
