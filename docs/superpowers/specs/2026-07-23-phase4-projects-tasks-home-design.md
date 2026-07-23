# Phase 4 — Projects & Tasks, Home Redesign: Design

**Status:** Approved by Russ 2026-07-23. Source of truth for scope/behavior is
`portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2 items 4 and 7, and the Phase 4 execution
section (§4). This document captures the wiring-level decisions the plan states as
outcomes but doesn't spell out mechanically, plus a handful of choices made during
brainstorming that sharpen the original sketch.

## Scope

Phase 4 = exactly: workspace-scoped projects & tasks (board + list views, task detail
drawer with comments) → Home page redesign (My Tasks widget, workspace cards with
last-activity, universal Recent Activity strip). Ships together in one PR (v0.6.0),
same one-phase-one-PR discipline as Phases 1–3.

**Not in scope** (Phase 5 per the plan's phased execution section): drag-drop task
board, manual within-column task reordering of any kind, file attachments on tasks,
workspace search, mobile pass. `sort_order` exists on `tasks` now as schema
preparation for Phase 5's drag-drop, but Phase 4 never writes to it after task
creation.

## 1. Schema — `008_projects_tasks.sql`

> Filename corrected from the plan's original `004_projects_tasks.sql` sketch,
> written before Phases 1–3 claimed migrations `001`–`007`. See ADR-0005.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,               -- prj-<nanoid>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT                    -- soft delete; see §2 ceilings
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id, status);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,               -- tsk-<nanoid>
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),   -- denormalized for permission checks
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,   -- set once at creation (append); Phase 5 drag-drop prep, unused for reordering this phase
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT                    -- soft delete; see §2 ceilings
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status, sort_order);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status, due_date);
```

Design decisions (deviations from / sharpenings of the original plan sketch):

- **`sort_order` is write-once.** Set to `(current max sort_order in that
  project+status) + 1` at task creation; never updated by any Phase 4 code path.
  Brainstormed explicitly: the plan's "move via button/dropdown, not drag-drop yet"
  language refers to moving a task *between status columns* (a status change), not
  manual position-within-column reordering. Real reordering is Phase 5's drag-drop
  board — building a button-based reorder UI now would be thrown away.
- **`idx_tasks_assignee` includes `due_date`**, not in the plan's original sketch —
  added because it's exactly the index the new `GET /api/me/tasks` query needs
  (`WHERE assignee_id = ? AND status != 'done' ORDER BY due_date`).
- **No new `ON DELETE` behavior beyond what Phase 3's ADR-0004 already established**:
  `projects.workspace_id` and `tasks.workspace_id`/`tasks.project_id` have no `ON
  DELETE` clause, matching every other same-shape FK in this schema. `tasks` and
  `projects` join the explicit-delete list in `handleDeleteWorkspace` (alongside
  `files`, `folders`, `invitations`, `user_workspaces`, `comments`).
- **Both tables are entirely new** — no `ALTER TABLE` on existing tables in this
  migration, so none of ADR-0004's D1 rename/rebuild sharp edges apply here at all.

## 2. Worker API

```
# Projects
GET    /api/workspaces/:slug/projects                 (member)   -- excludes deleted_at unless ?include_deleted=1 + admin
POST   /api/workspaces/:slug/projects                 (wsWrite)  body: {name, description?}
PATCH  /api/projects/:id                              (wsWrite)  body: {name?, description?, status?}
DELETE /api/projects/:id                              (creator or wsAdmin — soft delete; 409 if open tasks exist unless ?force=1)

# Tasks
GET    /api/projects/:id/tasks                        (member)   -- excludes deleted_at unless ?include_deleted=1 + admin
POST   /api/projects/:id/tasks                        (wsWrite)  body: {title, description?, assignee_id?, due_date?}
PATCH  /api/tasks/:id                                 (wsWrite)  body: {title?, description?, status?, assignee_id?, due_date?}
DELETE /api/tasks/:id                                 (creator or wsAdmin — soft delete only)

# Home widgets (new, cross-workspace, self-scoped — no workspace param)
GET    /api/me/tasks                                  (self)  -- assignee_id = caller, status != 'done', across every workspace the caller belongs to, ORDER BY due_date IS NULL, due_date ASC, LIMIT 10
GET    /api/me/activity?limit=50&before=              (self)  -- audit_log across every workspace the caller belongs to, same pagination shape as the per-workspace Activity tab, excludes workspace.view
```

Ceilings, extending the Phase 2/3 pattern (`requireWorkspaceAccess`,
`hasWorkspaceWriteAccess`, `hasWorkspaceAdminPermission`) — no new permission
concepts introduced:

- **Read** (projects, tasks): any workspace member.
- **Create/edit** (projects, tasks): `hasWorkspaceWriteAccess` — a `read`-permission
  member gets 403 on `POST`/`PATCH`, matching the plan's acceptance criterion.
- **Delete**: creator or `hasWorkspaceAdminPermission`, via new
  `projectDeleteViolation`/`taskDeleteViolation` helpers in `auth.js`, mirroring
  `commentDeleteViolation`'s exact shape (return a violation string or `null`).
  Always soft delete — the API never issues a hard `DELETE FROM projects`/`tasks`.
- **`/api/me/tasks`** and **`/api/me/activity`** have no workspace-scope parameter —
  implicitly scoped to `user.workspaceSlugs` (global admins see across every
  workspace, same as `handleListWorkspaces` today).

**Project delete cascade** (brainstormed): "open tasks" means any task with
`status IN ('todo','in_progress') AND deleted_at IS NULL`. A project whose tasks are
all `done` (or has none) deletes freely with no flag. If open tasks exist:
- Without `?force=1`: `409` with the open-task count.
- With `?force=1`: soft-deletes the project and every one of its non-done, non-deleted
  tasks (two sequential `UPDATE`s, matching how `handleDeleteWorkspace` already
  handles its multi-table cleanup — D1's binding has no multi-statement transaction).

**Task events** on the existing `notifyWorkspaceEvent`/`notification_inbox`
pipeline: `task.assign` and `task.status`.

## 3. Frontend

**Workspace Projects tab** (`WorkspaceDetail.jsx`, alongside Discussion/Activity/
Files/Members/Settings), two levels:

- **Project list** — cards showing name, status badge, open/done task counts. "New
  project" hidden for `read`-permission members (same gating pattern as the existing
  "New folder"/"Upload" actions). Clicking a card opens the project page.
- **Project page** — header (name, description, status `<select>`, edit/delete for
  creator/admin) plus a **board/list toggle** (component state only, not persisted
  server-side):
  - **Board**: three columns (Todo / In Progress / Done). Each task card shows
    title, assignee initial, due date, and a comment-count badge when >0. A status
    `<select>` per card is the "move via button/dropdown" mechanism — changing it
    fires `PATCH /api/tasks/:id {status}`. No drag-drop, no `sort_order` writes.
  - **List**: a flat table (title, assignee, due date, status), same data, denser.
    Clicking a row opens the drawer.
- **Task detail drawer** — a slide-over (reusing the `slide-over`/`slide-over__header`
  CSS from the Phase 3 CSS fix, third consumer after the file-comment panel):
  title, description, status, assignee `<select>` (workspace members only), due
  date picker, and the shared `CommentThread` component with `entityType="task"`
  (brainstormed: ships this phase, not deferred — the backend already accepts
  `entity_type: 'task'` per ADR-0004).

**Home redesign** (`Home.jsx`):
- **My Tasks** widget — new, above the workspace cards, visible to all users
  (brainstormed: not admin-gated). Each row: title, workspace name (tasks span
  workspaces), due date or "No due date", deep-links into the task's drawer via the
  same `?taskId=`-style pattern the notification bell already uses.
- **Workspace cards** — gain `last_activity_at` (relative time via the existing
  `formatTime` helper), computed with a correlated subquery in `handleListWorkspaces`
  (`MAX(created_at)` from `audit_log` where `action != 'workspace.view'`) — no new
  endpoint, visible to all users.
- **Recent Activity strip** — un-gated from `isAdmin` (brainstormed: was previously
  bundled inside the admin-only analytics block; now sourced from the new
  `GET /api/me/activity` instead). Same `activity-item`/`activity-list` CSS already
  in `Dashboard.css`.
- **System stats** (workspace/user/storage counts) — unchanged, stays inside the
  `isAdmin && analytics` block exactly as today.

## 4. Notification event wiring

New event types on `notifyWorkspaceEvent`: `task.assign`, `task.status`.

- **`task.assign`** fires only when `assignee_id` changes to a non-null value (not
  on every `PATCH`). Recipient is the new assignee only — unlike comment/member
  events, this does not notify the whole workspace. Reassignment notifies the new
  assignee; the previous assignee gets nothing (no "unassigned" event — not in the
  acceptance criteria).
- **`task.status`** fires on any status transition. Recipient is the current
  assignee if one is set; if unassigned, no notification fires (no one to tell).
- Both respect `email_pref` exactly like Phase 3's events (`all` emails everything,
  `mentions` emails neither — task events aren't mentions, `none` emails nothing);
  the inbox row always writes regardless of preference.

Acceptance example (from the plan): Chris assigns a task to Russ → Russ gets a
`task.assign` notification (bell + inbox always; email per his `email_pref`) and
sees the task in his My Tasks widget. Chris then moves it to `done` → Russ gets a
`task.status` notification and the task drops off his My Tasks widget.

## 5. Testing, ceilings, rollout

**Unit tests** (Vitest, mirroring `auth.test.js`'s existing style):
`projectDeleteViolation`/`taskDeleteViolation` (creator vs. `wsAdmin` vs. neither),
the open-tasks delete-block check as a pure function, and the My Tasks due-date
sort (nulls-last comparator) if it warrants extraction as its own pure function.

**Live ceiling tests** (post-deploy, same discipline as Phases 2/3): a
`read`-permission member can view the board but gets 403 creating/editing a task or
project; a non-admin, non-creator member gets 403 deleting another member's
project/task; deleting a project with open tasks returns 409 without `force=1` and
succeeds (soft-deleting its open tasks too) with it; Chris assigns a task to Russ →
Russ sees it in My Tasks and is notified; marking that task done removes it from
Russ's My Tasks and appears in the workspace's Activity tab.

**Rollout ordering:** migration `008_projects_tasks.sql` first (additive-only, both
tables entirely new — no ceiling-widening-before-data-narrowing constraint like
Phase 2 had). Then Worker deploy, then Pages deploy — deploy remains a separate,
explicit step after merge, same as every phase so far. Version bump to `0.6.0`.

**Acceptance** (from the plan, unchanged): Chris creates a project + tasks, assigns
one to Russ; Russ sees it in My Tasks and gets notified; status changes appear in
Activity; a `read`-permission user can view but not edit.
