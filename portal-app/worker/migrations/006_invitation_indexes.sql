-- 006_invitation_indexes.sql — restore indexes silently dropped by 004/005's
-- rename+recreate table rebuilds (SQLite preserves only inline PK/UNIQUE
-- constraints on a rebuild, not standalone CREATE INDEX statements), and add
-- a race guard for concurrent invitation creation.
--
-- Confirmed against production before writing this file: no two pending
-- invitations currently share a (workspace_id, lower(email)) pair, so the
-- new unique index below applies cleanly.

CREATE INDEX IF NOT EXISTS idx_user_workspaces_user ON user_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_user_workspaces_workspace ON user_workspaces(workspace_id);
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id);
CREATE INDEX IF NOT EXISTS idx_file_versions_created_at ON file_versions(created_at);
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON invitations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email, status);

-- handleCreateInvitation checks for an existing pending invitation before
-- inserting, but two concurrent requests could both pass that check. This
-- index makes a duplicate pending (workspace_id, email) pair impossible at
-- the database level regardless of application-level race conditions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_workspace_email
  ON invitations(workspace_id, email)
  WHERE status = 'pending';
