-- 007_comments_notifications.sql — Phase 3: comments, notification inbox,
-- email preference, activity workspace-scoping (PORTAL_OVERHAUL_PLAN.md §3.2.4/§3.5)
CREATE TABLE comments (
  id TEXT PRIMARY KEY,               -- cmt-<random>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('workspace','file','task')),
  entity_id TEXT NOT NULL,           -- workspace_id | file_id | task_id
  parent_comment_id TEXT REFERENCES comments(id),   -- one level deep only (enforced in API)
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  deleted_at TEXT                    -- soft delete; render as "[deleted]", replies survive
);
CREATE INDEX idx_comments_entity ON comments(workspace_id, entity_type, entity_id);

CREATE TABLE notification_inbox (
  id TEXT PRIMARY KEY,               -- ntf-<random>
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                         -- in-app route, e.g. /workspace/blueprint-advisory?tab=discussion
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox_user ON notification_inbox(user_id, read_at);

ALTER TABLE users ADD COLUMN email_pref TEXT NOT NULL DEFAULT 'all'
  CHECK (email_pref IN ('all','mentions','none'));
ALTER TABLE audit_log ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
