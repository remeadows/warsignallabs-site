-- 004_users_status_invited.sql — fix found during Phase 2 acceptance testing
-- (Task 10, 2026-07-19). Production's users.status column has a CHECK
-- constraint of ('active','inactive') only; the invitation feature
-- (002_collab_core.sql / requireAuth acceptance wiring) needs 'invited' as a
-- third valid value, per the spec's §3 intent. SQLite has no ALTER TABLE ...
-- ALTER CONSTRAINT, so the only way to change a CHECK constraint is a full
-- table rebuild: rename, recreate with the new constraint, copy rows, drop
-- the old table. Several other tables (user_workspaces, files, folders,
-- audit_log, invitations, notifications) hold `REFERENCES users(id)` — with
-- foreign_keys enforcement on (D1's default), the rename retargets those
-- FKs at the renamed table, so dropping it fails FOREIGN KEY constraint
-- checks. First attempt at this migration hit exactly that and rolled back
-- cleanly with no production impact (confirmed after the fact). Fix:
-- foreign_keys OFF for the duration of the rebuild, ON again after.
-- Verified end-to-end against a scratch copy that includes a real
-- referencing table (unlike the first, incomplete scratch test): rebuild
-- succeeds, existing rows survive unchanged, the FK join from
-- user_workspaces still resolves, 'invited' inserts succeed afterward, and
-- PRAGMA foreign_key_check reports clean.

PRAGMA foreign_keys=OFF;

ALTER TABLE users RENAME TO users_pre_invited_status;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'owner', 'client')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'invited')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  clerk_id TEXT
);

INSERT INTO users (id, username, email, role, status, created_at, updated_at, clerk_id)
  SELECT id, username, email, role, status, created_at, updated_at, clerk_id
  FROM users_pre_invited_status;

DROP TABLE users_pre_invited_status;

PRAGMA foreign_keys=ON;
