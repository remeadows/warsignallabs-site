-- 000_baseline.sql
-- Documents the schema as it exists in production today (pre-migration-system).
-- Every statement is IF NOT EXISTS: applying this to the existing prod database
-- is a no-op. New/local databases get the real schema from this file.
-- Every table/index definition below was extracted directly from
-- `SELECT sql FROM sqlite_master` against the real production `wsl-portal` D1
-- database, so a fresh bootstrap matches prod exactly (columns, constraints,
-- and indexes) rather than an approximation.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'owner', 'client')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  clerk_id TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#00c8d4',
  storage_quota_mb INTEGER NOT NULL DEFAULT 2048,
  storage_used_mb INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_user_workspaces_user ON user_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_user_workspaces_workspace ON user_workspaces(workspace_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_folder_id TEXT,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (parent_folder_id) REFERENCES folders(id)
);

CREATE INDEX IF NOT EXISTS idx_folders_workspace ON folders(workspace_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  category TEXT NOT NULL CHECK (category IN ('invoices', 'documents', 'deliverables', 'reports')),
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  folder_id TEXT REFERENCES folders(id)
);

CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id, category);

CREATE TABLE IF NOT EXISTS file_versions (
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

CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id);
CREATE INDEX IF NOT EXISTS idx_file_versions_created_at ON file_versions(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  recipient_email TEXT NOT NULL,
  recipient_user_id TEXT,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  metadata_json TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  resend_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_event_type ON notifications(event_type);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace_id ON notifications(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

CREATE TABLE IF NOT EXISTS briefs (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  agent_count INTEGER,
  validation_errors INTEGER,
  leads_json TEXT,
  actions_json TEXT,
  world_news_json TEXT,
  economy_json TEXT,
  threats_json TEXT,
  pipeline_json TEXT,
  content_json TEXT,
  security_json TEXT,
  raw_brief TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_briefs_created_at ON briefs(created_at);
