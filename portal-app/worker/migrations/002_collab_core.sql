-- 002_collab_core.sql — Phase 2: invitations (PORTAL_OVERHAUL_PLAN.md §3.4)
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read','write','admin')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email, status);
-- users.status gains 'invited' as a valid value (app-level; column is already TEXT)
