-- 008_projects_tasks.sql — Phase 4: workspace projects & tasks
-- (PORTAL_OVERHAUL_PLAN.md §3.2.4, spec 2026-07-23, ADR-0005)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,               -- prj-<random>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT                    -- soft delete only; API never hard-deletes
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id, status);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,               -- tsk-<random>
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),   -- denormalized for permission checks
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,                     -- YYYY-MM-DD or NULL
  sort_order REAL NOT NULL DEFAULT 0,  -- write-once append (Phase 5 drag-drop prep)
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT                    -- soft delete only; API never hard-deletes
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status, sort_order);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status, due_date);
