-- 005_fix_users_fk_cascade.sql — repairs cascade damage from 004.
-- 004 renamed `users` mid-rebuild to change its status CHECK constraint.
-- SQLite auto-rewrites *other* tables' schema text to follow a rename
-- (independent of the foreign_keys pragma, which only controls runtime
-- constraint enforcement) — so user_workspaces.user_id, invitations.invited_by,
-- and files.uploaded_by were left pointing at the now-dropped
-- "users_pre_invited_status" name. This broke ALL writes to those three
-- tables in production (confirmed: file uploads and invitations both failing
-- with "no such table: main.users_pre_invited_status" / FK errors).
-- Rebuilding `files` will in turn cascade the same problem onto
-- file_versions.file_id, so that is rebuilt too, in the same transaction,
-- before any table is dropped.

PRAGMA foreign_keys=OFF;

ALTER TABLE user_workspaces RENAME TO user_workspaces_old;
CREATE TABLE user_workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  permission TEXT NOT NULL DEFAULT 'read' CHECK(permission IN ('read', 'write', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, workspace_id)
);
INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
  SELECT id, user_id, workspace_id, permission, created_at FROM user_workspaces_old;
DROP TABLE user_workspaces_old;

ALTER TABLE invitations RENAME TO invitations_old;
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read','write','admin')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
INSERT INTO invitations (id, workspace_id, email, permission, invited_by, status, created_at, accepted_at)
  SELECT id, workspace_id, email, permission, invited_by, status, created_at, accepted_at FROM invitations_old;
DROP TABLE invitations_old;

ALTER TABLE files RENAME TO files_old;
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL CHECK(category IN ('invoices', 'documents', 'deliverables', 'reports')),
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  folder_id TEXT REFERENCES folders(id)
);
INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at, version, folder_id)
  SELECT id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at, version, folder_id FROM files_old;

-- Rebuild file_versions BEFORE dropping files_old: renaming `files` above
-- already retargeted file_versions.file_id at "files_old" the same way.
ALTER TABLE file_versions RENAME TO file_versions_old;
CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (file_id) REFERENCES files(id)
);
INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at)
  SELECT id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at FROM file_versions_old;
DROP TABLE file_versions_old;

DROP TABLE files_old;

PRAGMA foreign_keys=ON;
