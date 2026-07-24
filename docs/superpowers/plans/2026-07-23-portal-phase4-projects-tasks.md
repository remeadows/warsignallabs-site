# Portal Phase 4 — Projects & Tasks, Home Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship workspace-scoped projects & tasks (board + list views, task detail drawer with comments, assignment/status notifications) and the Home page redesign (My Tasks widget, workspace cards with last-activity, universal Recent Activity strip) — v0.6.0.

**Architecture:** One new migration adds `projects` and `tasks` (both entirely new tables — no `ALTER TABLE` anywhere this phase). Pure, unit-testable helpers land in `worker/src/auth.js` (`projectDeleteViolation`, `taskDeleteViolation`, `projectDeleteBlocked`, plus a `shouldEmailForPref` update adding `task.assign` to the `mentions` tier) mirroring the Phase 3 pattern. Two new route modules (`worker/src/routes/projects.js`, `worker/src/routes/tasks.js`) carry CRUD; task events (`task.assign`, `task.status`) ride the existing `notifyWorkspaceEvent` `recipientOverride` path with actor exclusion at the call sites. `comments.js` finally admits `entity_type: 'task'` (schema pre-provisioned since ADR-0004). Home widgets get two new self-scoped endpoints (`/api/me/tasks`, `/api/me/activity`) in `me.js`, and `handleListWorkspaces` grows a `last_activity_at` correlated subquery. Frontend adds a Projects tab (project list → project page with board/list toggle), a TaskDrawer slide-over mounting the existing `CommentThread` with `entityType="task"`, and the Home redesign — **with CSS written alongside every component in the same task** (the PR #34 lesson: Phase 3 shipped its entire UI with zero CSS and nothing caught it).

**Tech Stack:** Cloudflare Workers (ES modules), D1 (SQLite), Vitest, React 19 + react-router, Clerk JWT auth, Resend email.

**Spec:** `docs/superpowers/specs/2026-07-23-phase4-projects-tasks-home-design.md` (approved + amended 2026-07-23). ADR: `DECISIONS/0005-phase4-projects-tasks-schema.md`. Parent: `portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2 items 4/7, Phase 4 execution section (§4).

## Global Constraints

- **Rollout ordering (spec §5):** migration first, then Worker deploy, then Pages deploy — but NONE of that happens in this plan. Deploy is a separate, explicitly-requested step after merge (standing project convention). This plan ends at "branch ready for PR".
- **Migration filename is `008_projects_tasks.sql`** — the master plan's `004_` sketch predates Phases 1–3 consuming `001`–`007`.
- **Ceilings (verbatim from spec §2):**
  - Read (projects, tasks): any workspace member (`requireWorkspaceAccess`).
  - Create/edit (projects, tasks): `hasWorkspaceWriteAccess` — a `read`-permission member gets 403 on POST/PATCH.
  - Delete: creator or `hasWorkspaceAdminPermission`, via `projectDeleteViolation`/`taskDeleteViolation` (return violation string or `null`, exactly like `commentDeleteViolation`). Always soft delete — never a hard `DELETE FROM projects`/`tasks` through the **resource-level endpoints**. (The one deliberate exception: workspace teardown in `handleDeleteWorkspace` hard-deletes child rows in FK-safe order, matching how it already treats files/comments/invitations — see Task 7 and ADR-0005.)
  - `?include_deleted=1` requires **GLOBAL admin** (`user.role === 'admin'`), not `wsAdmin`.
  - Project delete: "open tasks" = `status IN ('todo','in_progress') AND deleted_at IS NULL`. Open tasks present + no `?force=1` → **409** with the count. With `?force=1` → soft-delete project AND its open tasks (two sequential UPDATEs). All-done or empty projects delete freely.
- **`sort_order` is write-once:** set at task creation to `(max in that project+status)+1`; NO Phase 4 code path ever updates it. No move-up/down UI. Reordering is Phase 5 drag-drop scope.
- **Notification rules (spec §4):**
  - `task.assign` fires on POST-create with an assignee AND on PATCH changing `assignee_id` to a new non-null value. Recipient = new assignee only, via `recipientOverride`.
  - `task.status` fires on any status transition. Recipient = current assignee; unassigned → no notification.
  - **Actor exclusion at the call site:** skip the `notifyWorkspaceEvent` call entirely when the would-be recipient IS the actor (`assigneeId === user.dbUserId`). The `recipientOverride` path deliberately has no actor-exclusion logic — do not add it there.
  - `shouldEmailForPref` `mentions` tier now includes `task.assign` (completing the master plan's "mentions & assignments only"); `task.status` stays `all`-tier-only. Inbox rows always write regardless of pref.
  - Settings radio label changes "Mentions only" → "Mentions & assignments".
- **Deep-link shape (pinned, baked into stored `notification_inbox.link` rows):** `/workspace/:slug?tab=projects&projectId=<id>&taskId=<id>`.
- **Endpoint contracts (spec §2):** tasks list returns `comment_count` per row (subquery against `comments`, `entity_type='task'`, excluding soft-deleted comments); `/api/me/tasks` rows carry `workspace_slug`, `workspace_name`, `project_id`; My Tasks = `assignee_id = caller AND status != 'done' AND deleted_at IS NULL`, includes tasks under paused/archived (non-deleted) projects, `ORDER BY due_date IS NULL, due_date ASC`, LIMIT 10.
- **`handleDeleteWorkspace` ordering:** `tasks` deleted BEFORE `projects` (FK `tasks.project_id → projects.id`).
- **CSS discipline (PR #34 lesson):** every frontend task writes its CSS in the same task as its JSX, and the final task runs a class-coverage check (every `className` literal used by new components must have a rule in some `.css` file). Use ONLY existing executive-theme variables — no new colors.
- **Naming:** the new `projects` domain is workspace collaboration. The existing `handleDashboardProjects`/`DashboardProjects.jsx` (GW-OS ops, `data/projects.json`) is unrelated — do not touch it, do not share names (`opsProjects` vs `projects` if ever in one scope).
- All commands run from `portal-app/` unless stated otherwise. Test: `npm test`. Lint baseline is 15 pre-existing problems — no NEW errors allowed. Verify per task: `npm test && npm run lint && npm run build`; backend tasks also `cd worker && npx wrangler deploy --dry-run`.
- Branch: `feat/portal-phase4-projects-tasks` off `main` (exists; has the spec + ADR commits). Commit after every task.
- Version ends at `0.6.0` (`portal-app/package.json`, bumped in the final task).

## Current-state facts the tasks rely on (verified 2026-07-23 against `main` @ `4087668`)

- **Migrations present:** `000_baseline.sql` … `007_comments_notifications.sql`. Next filename is `008_projects_tasks.sql`. Runner: `npm run migrate` → `worker/scripts/migrate.js`, tracks applied files in `schema_migrations` (never re-runs).
- **`worker/src/auth.js`** exports (tail): `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess`, `hasWorkspaceAdminPermission`, `memberChangeViolation`, `parseMentions`, `shouldEmailForPref` (~line 374: `'mentions'` → `eventType === 'comment.mention'` only — Task 2 updates this), `isCommentEditableBy`, `commentDeleteViolation` (~line 389 — the exact shape Task 2's new violation helpers copy).
- **`worker/src/auth.test.js`** import line (line 2) currently ends `...isCommentEditableBy, commentDeleteViolation } from './auth.js'` — Task 2 extends it. Has a `makeUser(overrides)` factory returning `{userId:'clerk_123', dbUserId:'usr-999', role:'client', workspaceSlugs:[], workspacePermissions:{}, email:'test@example.com'}`. `shouldEmailForPref` describe block is at ~line 168 — Task 2 extends it.
- **`worker/src/notify.js`**: `notifyWorkspaceEvent(env, ctx, {eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata, link, recipientOverride})` — `recipientOverride` is an array of `{email, userId, emailPref}` that bypasses recipient resolution AND actor exclusion; inbox row writes unconditionally per recipient, email gated by `shouldEmailForPref`. `resolveMentionRecipients(env, userIds)` returns `[{email, userId, emailPref}]` for active users with emails — Task 4 reuses it for the single-assignee lookup. `escapeHtml(str)` exported.
- **`worker/src/routes/members.js`** exports `getWorkspaceBySlug(env, slug)` → `{id, name, slug} | null` — Tasks 3/4 import it, same as `comments.js` does.
- **`worker/src/routes/comments.js`**: `handleCreateComment` validates `entity_type` against `['workspace','file']` at ~line 51 with the comment "'task' stays out … until Phase 4 ships tasks" — Task 5 lifts this. The file-comment `link` construction at ~line 99 is the pattern the task-comment link extends. Comment id format: `cmt-${crypto.randomUUID().slice(0, 8)}`.
- **`worker/src/routes/workspaces.js`**: `handleListWorkspaces` (~line 10) has two branches (admin: all workspaces; else `slug IN (...)`) both selecting `id, name, slug, color, created_at` — Task 7 adds the `last_activity_at` subquery to BOTH. `handleDeleteWorkspace` (~line 229) deletes, in order: R2 objects, `files`, `comments`, `invitations`, `user_workspaces`, `workspaces` — Task 7 inserts `tasks` then `projects` after `comments`. `handleGetActivity` (~line 95) is the pagination model Task 6's `handleMyActivity` copies (`decodeCursor`/`seekCondition` from `../pagination.js`, limit clamp `Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50`, excludes `workspace.view`).
- **`worker/src/routes/me.js`**: has `handleMe`, `handleListNotifications`, `handleMarkNotificationsRead`, `handleUpdatePreferences`. Task 6 appends `handleMyTasks` + `handleMyActivity`. Note `handleListNotifications` imports from `../pagination.js` already.
- **`worker/src/router.js`**: one import block per route file; dispatch via `matchPath(pattern, pathname)`. `/api/me` is an EXACT match (line ~115) so `/api/me/tasks` and `/api/me/activity` need their own exact matches (put them next to the existing `/api/me/preferences` exact match, ~line 239). `matchPath('/api/projects/:id')` cannot collide with the existing exact `/api/dashboard/projects` (segment 3 differs). The comments block (~line 216) is the wiring model.
- **`src/api/client.js`**: single `useMemo` object of `apiFetch`-backed methods; Comments/Activity/Notifications (Phase 3) section at ~line 178 is the model to extend. `listMembers(slug)` exists (Phase 2) — the TaskDrawer assignee `<select>` uses it; it returns `{members: [{id, username, email, permission, ...}]}`.
- **`src/pages/WorkspaceDetail.jsx`**: `WORKSPACE_TABS = ['files', 'discussion', 'activity', 'members']` at line 70 — Task 9 adds `'projects'`. Tab bar buttons at ~line 443; tab bodies `{activeTab === 'x' && <Component/>}` at ~line 452. The `fileId`/`comments=1` deep-link consumption effect (~line 114) is the consume-once pattern (strip params with `{replace: true}`) that ProjectsTab's `projectId`/`taskId` consumption copies. `wsAdmin` and `d1User` come from `usePortalAuth()`.
- **`src/components/workspace/ActivityTab.jsx`**: `describeAction` label map at ~line 7 — Task 9 adds project/task labels.
- **`src/components/workspace/WorkspaceSettingsTab.jsx`**: email-pref radio options array at ~line 82: `{ value: 'mentions', label: 'Mentions only' }` — Task 10 changes the label.
- **`src/pages/Home.jsx`** (157 lines): loads `listWorkspaces` + admin-gated `getAnalytics`; workspace cards grid; admin-only stats row; Recent Activity strip currently fed by `analytics.recentActivity` (admin-only) — Task 11 rewires it to the new `/api/me/activity` for everyone. `formatTime`/`formatBytes`/`actionLabel` helpers already in the file.
- **CSS state:** `slide-over`, `slide-over-overlay`, `slide-over__header`, `modal__close`, `link-btn`, `btn--sm`, `workspace__alert--error`, `comment-thread*`, `activity-tab*` classes all exist (PR #34). `Dashboard.css` has `dashboard__grid`, `workspace-card*`, `activity-list`, `activity-item*`, `stats-row`, `stat*`.
- **Production users:** `usr-001` armeadows (admin), `usr-003` rmeadows (admin), `usr-004` cdepalma (owner).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `worker/migrations/008_projects_tasks.sql` | Create | `projects`, `tasks` tables + 2 indexes |
| `worker/src/auth.js` | Modify | `projectDeleteViolation`, `taskDeleteViolation`, `projectDeleteBlocked`; `shouldEmailForPref` gains `task.assign` in `mentions` tier |
| `worker/src/auth.test.js` | Modify | Tests for the three new helpers + updated `shouldEmailForPref` matrix |
| `worker/src/routes/projects.js` | Create | Project CRUD + open-task delete guard/cascade |
| `worker/src/routes/tasks.js` | Create | Task CRUD + `task.assign`/`task.status` notifications (actor-excluded) |
| `worker/src/routes/comments.js` | Modify | Admit `entity_type: 'task'` with workspace-scoped validation + task deep-link |
| `worker/src/routes/me.js` | Modify | `handleMyTasks`, `handleMyActivity` |
| `worker/src/routes/workspaces.js` | Modify | `last_activity_at` on list; `tasks`+`projects` in delete cascade (tasks first) |
| `worker/src/router.js` | Modify | Routes for projects, tasks, me/tasks, me/activity |
| `src/api/client.js` | Modify | Project/task/my-tasks/my-activity methods |
| `src/components/workspace/ProjectsTab.jsx` | Create | Project list → project page, board/list toggle, deep-link consumption |
| `src/components/TaskDrawer.jsx` | Create | Slide-over: task fields + `CommentThread entityType="task"` |
| `src/pages/WorkspaceDetail.jsx` | Modify | Projects tab wiring |
| `src/components/workspace/ActivityTab.jsx` | Modify | project/task action labels |
| `src/components/workspace/WorkspaceSettingsTab.jsx` | Modify | "Mentions & assignments" label |
| `src/pages/Home.jsx` | Modify | My Tasks widget, last-activity on cards, universal activity strip |
| `src/pages/WorkspaceDetail.css` | Modify | Projects tab / board / task-card / drawer styles |
| `src/pages/Dashboard.css` | Modify | My Tasks widget styles, workspace-card activity line |
| `package.json` | Modify | 0.5.0 → 0.6.0 (final task) |

---

### Task 1: Migration — projects, tasks

**Files:**
- Create: `worker/migrations/008_projects_tasks.sql`

**Interfaces:** Produces the schema every later task depends on. NOT run against remote D1 in this plan — migration execution is part of the (separate, later) deploy step.

- [ ] **Step 1:** Create `worker/migrations/008_projects_tasks.sql` (verbatim from spec §1):

```sql
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
```

- [ ] **Step 2: Validate locally** (scratch SQLite only — NOT remote D1). Must apply on top of the full chain:

```bash
cd portal-app/worker
rm -f /tmp/phase4-mig-check.db
for f in migrations/0*.sql; do sqlite3 /tmp/phase4-mig-check.db < "$f"; done
sqlite3 /tmp/phase4-mig-check.db ".schema projects" | grep -c "CHECK"
sqlite3 /tmp/phase4-mig-check.db ".schema tasks" | grep -c "CHECK"
sqlite3 /tmp/phase4-mig-check.db ".indexes tasks"
rm /tmp/phase4-mig-check.db
```

Expected: no errors applying; both greps print `1`; indexes list shows `idx_tasks_assignee idx_tasks_project`.

- [ ] **Step 3: Commit.**

```bash
git add worker/migrations/008_projects_tasks.sql
git commit -m "feat(portal): projects + tasks schema (not yet applied) — ADR-0005"
```

---

### Task 2: Pure helpers — delete ceilings, open-task guard, email-tier update

**Files:**
- Modify: `worker/src/auth.js` (append after `commentDeleteViolation`, ~line 395; edit `shouldEmailForPref`, ~line 374)
- Test: `worker/src/auth.test.js`

**Interfaces:**
- Produces (Tasks 3/4 rely on these exact names):
  - `projectDeleteViolation(user, project, workspaceSlug) → string | null` — null = allowed. Allowed: `project.created_by === (user.dbUserId || user.userId)` or `hasWorkspaceAdminPermission(user, workspaceSlug)`.
  - `taskDeleteViolation(user, task, workspaceSlug) → string | null` — same rule against `task.created_by`.
  - `projectDeleteBlocked(openTaskCount, force) → string | null` — non-null when `openTaskCount > 0` and `force` is falsy.
  - `shouldEmailForPref(emailPref, eventType)` — CHANGED: `'mentions'` now returns true for `'comment.mention'` OR `'task.assign'` (not `task.status`).

- [ ] **Step 1: Write the failing tests.** In `worker/src/auth.test.js`, extend the import line (line 2) to add `projectDeleteViolation, taskDeleteViolation, projectDeleteBlocked`, add two cases inside the existing `shouldEmailForPref` describe (~line 168), and append new describes at the end of the file:

```javascript
// Inside the existing describe('shouldEmailForPref') — add to the 'mentions' block:
  it('mentions tier includes task.assign but not task.status (spec §4, "mentions & assignments only")', () => {
    expect(shouldEmailForPref('mentions', 'task.assign')).toBe(true)
    expect(shouldEmailForPref('mentions', 'task.status')).toBe(false)
  })
  it('all/none tiers treat task events like any other', () => {
    expect(shouldEmailForPref('all', 'task.assign')).toBe(true)
    expect(shouldEmailForPref('all', 'task.status')).toBe(true)
    expect(shouldEmailForPref('none', 'task.assign')).toBe(false)
  })

// Appended at end of file:
describe('projectDeleteViolation', () => {
  const project = { created_by: 'usr-999' }

  it('allows the creator', () => {
    expect(projectDeleteViolation(makeUser(), project, 'acme')).toBeNull()
  })
  it('allows wsAdmin who is not the creator', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'admin' } })
    expect(projectDeleteViolation(u, project, 'acme')).toBeNull()
  })
  it('allows a global admin', () => {
    const u = makeUser({ dbUserId: 'usr-002', role: 'admin' })
    expect(projectDeleteViolation(u, project, 'acme')).toBeNull()
  })
  it('blocks a write-permission non-creator', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'write' } })
    expect(projectDeleteViolation(u, project, 'acme')).toMatch(/creator or a workspace admin/)
  })
})

describe('taskDeleteViolation', () => {
  const task = { created_by: 'usr-999' }

  it('allows the creator', () => {
    expect(taskDeleteViolation(makeUser(), task, 'acme')).toBeNull()
  })
  it('blocks a non-creator without admin permission', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'write' } })
    expect(taskDeleteViolation(u, task, 'acme')).toMatch(/creator or a workspace admin/)
  })
  it('allows wsAdmin', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'admin' } })
    expect(taskDeleteViolation(u, task, 'acme')).toBeNull()
  })
})

describe('projectDeleteBlocked', () => {
  it('blocks when open tasks exist and force is not set', () => {
    expect(projectDeleteBlocked(3, false)).toMatch(/3 open task/)
  })
  it('allows when open tasks exist but force is set', () => {
    expect(projectDeleteBlocked(3, true)).toBeNull()
  })
  it('allows when no open tasks', () => {
    expect(projectDeleteBlocked(0, false)).toBeNull()
  })
  it('singularizes the message for one task', () => {
    expect(projectDeleteBlocked(1, false)).toMatch(/1 open task —/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `npm test`
Expected: FAIL — `projectDeleteViolation is not a function` (import error) and the two new `shouldEmailForPref` cases fail (`task.assign` under `mentions` currently returns `false`).

- [ ] **Step 3: Implement.** In `worker/src/auth.js`, change `shouldEmailForPref` (~line 374):

```javascript
// Whether a notification email should be sent to a recipient with the given
// email_pref, for the given event type (Phase 3 spec §4; Phase 4 spec §4 adds
// task.assign — the master plan's middle tier is "mentions & ASSIGNMENTS only").
// task.status stays 'all'-tier-only: routine activity, not a directed event.
// Never gates the inbox row — only the email leg.
export function shouldEmailForPref(emailPref, eventType) {
  if (emailPref === 'none') return false
  if (emailPref === 'mentions') return eventType === 'comment.mention' || eventType === 'task.assign'
  return true // 'all'
}
```

And append after `commentDeleteViolation`:

```javascript
// Delete ceilings for projects/tasks (Phase 4 spec §2): creator, wsAdmin, or
// global admin. Same shape as commentDeleteViolation — always soft delete at
// the call site; these only decide who may do it.
export function projectDeleteViolation(user, project, workspaceSlug) {
  const isCreator = project.created_by === (user.dbUserId || user.userId)
  if (isCreator || hasWorkspaceAdminPermission(user, workspaceSlug)) return null
  return 'Only the project creator or a workspace admin may delete this project'
}

export function taskDeleteViolation(user, task, workspaceSlug) {
  const isCreator = task.created_by === (user.dbUserId || user.userId)
  if (isCreator || hasWorkspaceAdminPermission(user, workspaceSlug)) return null
  return 'Only the task creator or a workspace admin may delete this task'
}

// Open-task guard for project deletion (Phase 4 spec §2): a project with
// todo/in_progress tasks blocks (409 at the call site) unless force is set,
// in which case the call site also soft-deletes those tasks.
export function projectDeleteBlocked(openTaskCount, force) {
  if (openTaskCount > 0 && !force) {
    return `Project has ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} — pass force=1 to delete them too`
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Verify lint + commit.**

```bash
npm run lint   # 15 pre-existing problems, no new ones
git add worker/src/auth.js worker/src/auth.test.js
git commit -m "feat(portal): project/task delete ceilings + task.assign joins mentions email tier"
```

---

### Task 3: Worker routes — projects CRUD

**Files:**
- Create: `worker/src/routes/projects.js`
- Modify: `worker/src/router.js`

**Interfaces:**
- Consumes: `projectDeleteViolation`, `projectDeleteBlocked` (Task 2); `getWorkspaceBySlug` (members.js).
- Produces routes: `GET/POST /api/workspaces/:slug/projects`, `PATCH/DELETE /api/projects/:id`. Task 4 relies on project id format `prj-<8 hex>`; Task 8's client methods match these paths exactly.

- [ ] **Step 1:** Create `worker/src/routes/projects.js`:

```javascript
// worker/src/routes/projects.js
// Workspace projects (Phase 4). NOT the GW-OS ops dashboard's "projects"
// (routes/admin.js handleDashboardProjects) — unrelated domain.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, projectDeleteViolation, projectDeleteBlocked } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { getWorkspaceBySlug } from './members.js'

const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived']

/** Fetch a project + its workspace slug, or null. Used by PATCH/DELETE (id-addressed). */
async function getProjectWithWorkspace(env, projectId) {
  return env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.name, p.status, p.created_by, p.deleted_at,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM projects p INNER JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = ?`,
  ).bind(projectId).first()
}

/** GET /api/workspaces/:slug/projects — any member. ?include_deleted=1 is GLOBAL-admin-only. */
export async function handleListProjects(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const url = new URL(request.url)
  const includeDeleted = url.searchParams.get('include_deleted') === '1' && user.role === 'admin'

  const result = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.status, p.created_by, p.created_at, p.updated_at, p.deleted_at,
            u.username AS created_by_username,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.deleted_at IS NULL) AS open_task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done' AND t.deleted_at IS NULL) AS done_task_count
     FROM projects p LEFT JOIN users u ON u.id = p.created_by
     WHERE p.workspace_id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}
     ORDER BY p.created_at DESC`,
  ).bind(workspace.id).all()

  return jsonResponse({ projects: result.results })
}

/** POST /api/workspaces/:slug/projects — wsWrite. Body: {name, description?} */
export async function handleCreateProject(request, env, user, params) {
  if (!hasWorkspaceWriteAccess(user, params.slug)) {
    throw errorResponse('Forbidden: write permission required to create a project', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!body?.name || !body.name.trim()) return errorResponse('name is required', 400)

  const projectId = `prj-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO projects (id, workspace_id, name, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(projectId, workspace.id, body.name.trim(), body.description?.trim() || null, user.dbUserId).run()

  await logAudit(env, user.userId, 'project.create', {
    resourceType: 'project', resourceId: projectId,
    workspaceId: workspace.id, workspaceSlug: params.slug,
    name: body.name.trim(), ipAddress: getClientIp(request),
  })

  return jsonResponse({ project: { id: projectId, name: body.name.trim(), status: 'active' } }, 201)
}

/** PATCH /api/projects/:id — wsWrite. Body: {name?, description?, status?} */
export async function handleUpdateProject(request, env, user, params) {
  const project = await getProjectWithWorkspace(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  if (!hasWorkspaceWriteAccess(user, project.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const updates = []
  const bindings = []
  if (body.name !== undefined) {
    if (!body.name || !body.name.trim()) return errorResponse('name cannot be empty', 400)
    updates.push('name = ?'); bindings.push(body.name.trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?'); bindings.push(body.description?.trim() || null)
  }
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status)) {
      return errorResponse(`status must be one of: ${PROJECT_STATUSES.join(', ')}`, 400)
    }
    updates.push('status = ?'); bindings.push(body.status)
  }
  if (updates.length === 0) return errorResponse('No fields to update', 400)

  updates.push("updated_at = datetime('now')")
  bindings.push(project.id)
  await env.DB.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings).run()

  await logAudit(env, user.userId, 'project.update', {
    resourceType: 'project', resourceId: project.id,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    changes: Object.keys(body), ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Project updated' })
}

/** DELETE /api/projects/:id — creator or wsAdmin. Soft delete; 409 on open tasks unless ?force=1. */
export async function handleDeleteProject(request, env, user, params) {
  const project = await getProjectWithWorkspace(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  requireWorkspaceAccess(user, project.workspace_slug)

  const violation = projectDeleteViolation(user, project, project.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'project.delete.denied', {
      resourceType: 'project', resourceId: project.id,
      workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
      reason: violation, ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  const url = new URL(request.url)
  const force = url.searchParams.get('force') === '1'
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tasks
     WHERE project_id = ? AND status IN ('todo','in_progress') AND deleted_at IS NULL`,
  ).bind(project.id).first()

  const blocked = projectDeleteBlocked(open?.count || 0, force)
  if (blocked) return errorResponse(blocked, 409)

  // With force: soft-delete the open tasks too. Two sequential UPDATEs —
  // matches handleDeleteWorkspace's multi-statement pattern (no D1 multi-
  // statement transactions via the binding). Done tasks stay untouched.
  if (force && open?.count > 0) {
    await env.DB.prepare(
      `UPDATE tasks SET deleted_at = datetime('now')
       WHERE project_id = ? AND status IN ('todo','in_progress') AND deleted_at IS NULL`,
    ).bind(project.id).run()
  }
  await env.DB.prepare(`UPDATE projects SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(project.id).run()

  await logAudit(env, user.userId, 'project.delete', {
    resourceType: 'project', resourceId: project.id,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    name: project.name, forcedOpenTasks: force ? (open?.count || 0) : 0,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Project deleted' })
}
```

- [ ] **Step 2: Wire the router.** In `worker/src/router.js`, add the import block after the comments import (~line 72):

```javascript
import {
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
} from './routes/projects.js'
```

And add dispatch after the comments block (~line 230):

```javascript
        params = matchPath('/api/workspaces/:slug/projects', pathname)
        if (params && method === 'GET') {
          return await handleListProjects(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateProject(request, env, user, params)
        }

        params = matchPath('/api/projects/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateProject(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteProject(request, env, user, params)
        }
```

- [ ] **Step 3: Verify.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
```

Expected: tests pass, lint at baseline, build + dry-run clean.

- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/projects.js worker/src/router.js
git commit -m "feat(portal): project CRUD routes with open-task delete guard"
```

---

### Task 4: Worker routes — tasks CRUD + assignment/status notifications

**Files:**
- Create: `worker/src/routes/tasks.js`
- Modify: `worker/src/router.js`

**Interfaces:**
- Consumes: `taskDeleteViolation` (Task 2); `resolveMentionRecipients`, `notifyWorkspaceEvent`, `escapeHtml` (notify.js); `getWorkspaceBySlug` (members.js).
- Produces routes: `GET/POST /api/projects/:id/tasks`, `PATCH/DELETE /api/tasks/:id`. Task list rows include `comment_count` and `assignee_username`. Audit actions: `task.create`, `task.update`, `task.status`, `task.delete` (+ `.denied` variants). Notification links use the pinned deep-link shape.

- [ ] **Step 1:** Create `worker/src/routes/tasks.js`:

```javascript
// worker/src/routes/tasks.js
// Tasks within a workspace project (Phase 4). Notifications are directed
// (recipientOverride to the assignee only) with actor exclusion HERE at the
// call sites — recipientOverride deliberately has none (spec §4).
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, taskDeleteViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, resolveMentionRecipients, escapeHtml } from '../notify.js'

const TASK_STATUSES = ['todo', 'in_progress', 'done']
const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Fetch a non-deleted project + workspace context for the :id-addressed task routes. */
async function getProjectContext(env, projectId) {
  return env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.deleted_at, w.slug AS workspace_slug, w.name AS workspace_name
     FROM projects p INNER JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = ?`,
  ).bind(projectId).first()
}

async function getTaskWithContext(env, taskId) {
  return env.DB.prepare(
    `SELECT t.id, t.project_id, t.workspace_id, t.title, t.status, t.assignee_id,
            t.due_date, t.created_by, t.deleted_at,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM tasks t INNER JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.id = ?`,
  ).bind(taskId).first()
}

/** Assignee must be an active workspace member or an active global admin. */
async function isValidAssignee(env, workspaceId, assigneeId) {
  const row = await env.DB.prepare(
    `SELECT u.id FROM users u
     LEFT JOIN user_workspaces uw ON uw.user_id = u.id AND uw.workspace_id = ?
     WHERE u.id = ? AND u.status = 'active' AND (uw.id IS NOT NULL OR u.role = 'admin')`,
  ).bind(workspaceId, assigneeId).first()
  return !!row
}

function taskLink(slug, projectId, taskId) {
  // Pinned deep-link shape (spec §3) — this string is stored in
  // notification_inbox.link rows, so keep it in exactly this form.
  return `/workspace/${slug}?tab=projects&projectId=${projectId}&taskId=${taskId}`
}

/**
 * Directed notification to the task's assignee. Silently does nothing when
 * there is no assignee or the assignee IS the actor (spec §4 actor exclusion —
 * the assignee moving their own task must not ping their own bell).
 */
async function notifyAssignee(env, ctx, { eventType, assigneeId, actor, workspace, slug, projectId, taskId, title, bodyLines }) {
  if (!assigneeId || assigneeId === actor.dbUserId) return
  const recipients = await resolveMentionRecipients(env, [assigneeId])
  if (recipients.length === 0) return
  notifyWorkspaceEvent(env, ctx, {
    eventType,
    workspaceId: workspace.workspace_id || workspace.id,
    workspaceName: workspace.workspace_name || workspace.name,
    title,
    bodyLines,
    actorEmail: actor.email,
    link: taskLink(slug, projectId, taskId),
    recipientOverride: recipients.map((r) => ({ email: r.email, userId: r.userId, emailPref: r.emailPref })),
    metadata: { taskId, projectId },
  })
}

/** GET /api/projects/:id/tasks — any member. ?include_deleted=1 is GLOBAL-admin-only. */
export async function handleListTasks(request, env, user, params) {
  const project = await getProjectContext(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  requireWorkspaceAccess(user, project.workspace_slug)

  const url = new URL(request.url)
  const includeDeleted = url.searchParams.get('include_deleted') === '1' && user.role === 'admin'

  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.assignee_id, t.due_date,
            t.sort_order, t.created_by, t.created_at, t.updated_at, t.deleted_at,
            u.username AS assignee_username,
            (SELECT COUNT(*) FROM comments c
             WHERE c.entity_type = 'task' AND c.entity_id = t.id AND c.deleted_at IS NULL) AS comment_count
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.project_id = ?${includeDeleted ? '' : ' AND t.deleted_at IS NULL'}
     ORDER BY t.status, t.sort_order`,
  ).bind(project.id).all()

  return jsonResponse({ tasks: result.results })
}

/** POST /api/projects/:id/tasks — wsWrite. Body: {title, description?, assignee_id?, due_date?} */
export async function handleCreateTask(request, env, user, params, ctx) {
  const project = await getProjectContext(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  if (!hasWorkspaceWriteAccess(user, project.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required to create a task', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!body?.title || !body.title.trim()) return errorResponse('title is required', 400)
  if (body.due_date && !DATE_RE.test(body.due_date)) {
    return errorResponse('due_date must be YYYY-MM-DD', 400)
  }
  if (body.assignee_id && !(await isValidAssignee(env, project.workspace_id, body.assignee_id))) {
    return errorResponse('assignee_id is not an active member of this workspace', 400)
  }

  // sort_order is write-once (ADR-0005): append to the end of the 'todo'
  // column (all new tasks start as 'todo'); never updated after this.
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tasks
     WHERE project_id = ? AND status = 'todo' AND deleted_at IS NULL`,
  ).bind(project.id).first()

  const taskId = `tsk-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO tasks (id, project_id, workspace_id, title, description, assignee_id, due_date, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(
    taskId, project.id, project.workspace_id, body.title.trim(),
    body.description?.trim() || null, body.assignee_id || null,
    body.due_date || null, (maxRow?.max_order || 0) + 1, user.dbUserId,
  ).run()

  await logAudit(env, user.userId, 'task.create', {
    resourceType: 'task', resourceId: taskId,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    projectId: project.id, title: body.title.trim(),
    ipAddress: getClientIp(request),
  })

  // task.assign fires on creation-with-assignee too (spec §4).
  await notifyAssignee(env, ctx, {
    eventType: 'task.assign',
    assigneeId: body.assignee_id || null,
    actor: user,
    workspace: project,
    slug: project.workspace_slug,
    projectId: project.id,
    taskId,
    title: `You were assigned "${escapeHtml(body.title.trim())}" in ${escapeHtml(project.workspace_name)}`,
    bodyLines: [
      `<strong>${escapeHtml(user.email || 'Someone')}</strong> assigned you a task:`,
      escapeHtml(body.title.trim()),
    ],
  })

  return jsonResponse({ task: { id: taskId, title: body.title.trim(), status: 'todo' } }, 201)
}

/** PATCH /api/tasks/:id — wsWrite. Body: {title?, description?, status?, assignee_id?, due_date?} */
export async function handleUpdateTask(request, env, user, params, ctx) {
  const task = await getTaskWithContext(env, params.id)
  if (!task || task.deleted_at) return errorResponse('Task not found', 404)
  if (!hasWorkspaceWriteAccess(user, task.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const updates = []
  const bindings = []
  if (body.title !== undefined) {
    if (!body.title || !body.title.trim()) return errorResponse('title cannot be empty', 400)
    updates.push('title = ?'); bindings.push(body.title.trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?'); bindings.push(body.description?.trim() || null)
  }
  if (body.due_date !== undefined) {
    if (body.due_date && !DATE_RE.test(body.due_date)) {
      return errorResponse('due_date must be YYYY-MM-DD', 400)
    }
    updates.push('due_date = ?'); bindings.push(body.due_date || null)
  }
  const statusChanged = body.status !== undefined && body.status !== task.status
  if (body.status !== undefined) {
    if (!TASK_STATUSES.includes(body.status)) {
      return errorResponse(`status must be one of: ${TASK_STATUSES.join(', ')}`, 400)
    }
    if (statusChanged) { updates.push('status = ?'); bindings.push(body.status) }
  }
  const assigneeChanged = body.assignee_id !== undefined && body.assignee_id !== task.assignee_id
  if (assigneeChanged) {
    if (body.assignee_id && !(await isValidAssignee(env, task.workspace_id, body.assignee_id))) {
      return errorResponse('assignee_id is not an active member of this workspace', 400)
    }
    updates.push('assignee_id = ?'); bindings.push(body.assignee_id || null)
  }
  if (updates.length === 0) return errorResponse('No fields to update', 400)

  updates.push("updated_at = datetime('now')")
  bindings.push(task.id)
  await env.DB.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings).run()

  // Audit: status transitions get their own action so the Activity feed can
  // label them distinctly ("moved X to done" vs "edited a task").
  await logAudit(env, user.userId, statusChanged ? 'task.status' : 'task.update', {
    resourceType: 'task', resourceId: task.id,
    workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
    projectId: task.project_id, title: task.title,
    ...(statusChanged ? { from: task.status, to: body.status } : { changes: Object.keys(body) }),
    ipAddress: getClientIp(request),
  })

  // task.assign — only on a change to a NEW non-null assignee (spec §4).
  if (assigneeChanged && body.assignee_id) {
    await notifyAssignee(env, ctx, {
      eventType: 'task.assign',
      assigneeId: body.assignee_id,
      actor: user,
      workspace: task,
      slug: task.workspace_slug,
      projectId: task.project_id,
      taskId: task.id,
      title: `You were assigned "${escapeHtml(task.title)}" in ${escapeHtml(task.workspace_name)}`,
      bodyLines: [
        `<strong>${escapeHtml(user.email || 'Someone')}</strong> assigned you a task:`,
        escapeHtml(task.title),
      ],
    })
  }

  // task.status — to the CURRENT assignee (post-update if it changed in the
  // same PATCH), actor-excluded inside notifyAssignee.
  if (statusChanged) {
    const currentAssignee = assigneeChanged ? (body.assignee_id || null) : task.assignee_id
    await notifyAssignee(env, ctx, {
      eventType: 'task.status',
      assigneeId: currentAssignee,
      actor: user,
      workspace: task,
      slug: task.workspace_slug,
      projectId: task.project_id,
      taskId: task.id,
      title: `"${escapeHtml(task.title)}" moved to ${STATUS_LABELS[body.status]} in ${escapeHtml(task.workspace_name)}`,
      bodyLines: [
        `<strong>${escapeHtml(user.email || 'Someone')}</strong> moved a task to <strong>${STATUS_LABELS[body.status]}</strong>:`,
        escapeHtml(task.title),
      ],
    })
  }

  return jsonResponse({ message: 'Task updated' })
}

/** DELETE /api/tasks/:id — creator or wsAdmin. Soft delete only. */
export async function handleDeleteTask(request, env, user, params) {
  const task = await getTaskWithContext(env, params.id)
  if (!task || task.deleted_at) return errorResponse('Task not found', 404)
  requireWorkspaceAccess(user, task.workspace_slug)

  const violation = taskDeleteViolation(user, task, task.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'task.delete.denied', {
      resourceType: 'task', resourceId: task.id,
      workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
      reason: violation, ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(task.id).run()

  await logAudit(env, user.userId, 'task.delete', {
    resourceType: 'task', resourceId: task.id,
    workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
    projectId: task.project_id, title: task.title,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Task deleted' })
}
```

- [ ] **Step 2: Wire the router.** In `worker/src/router.js`, extend the projects import block from Task 3 to also import from `./routes/tasks.js`:

```javascript
import {
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
} from './routes/tasks.js'
```

And add dispatch immediately after the projects block (Task 3). ORDER MATTERS: `/api/projects/:id/tasks` has 5 segments, `/api/projects/:id` has 4 — `matchPath` requires equal lengths so there's no overlap, but keep tasks after projects for readability:

```javascript
        params = matchPath('/api/projects/:id/tasks', pathname)
        if (params && method === 'GET') {
          return await handleListTasks(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateTask(request, env, user, params, ctx)
        }

        params = matchPath('/api/tasks/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateTask(request, env, user, params, ctx)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteTask(request, env, user, params)
        }
```

- [ ] **Step 3: Verify.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
```

- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/tasks.js worker/src/router.js
git commit -m "feat(portal): task CRUD routes + actor-excluded assign/status notifications"
```

---

### Task 5: Comments — admit entity_type 'task'

**Files:**
- Modify: `worker/src/routes/comments.js` (~lines 48–68 validation; ~line 99 link construction)

**Interfaces:**
- Consumes: the `tasks` table (Task 1). Produces: `POST /api/workspaces/:slug/comments` accepts `entity_type: 'task'`; task-comment notification links use the pinned deep-link shape. Task 10's TaskDrawer relies on this.

- [ ] **Step 1:** In `handleCreateComment`, replace the allowlist + validation block (currently rejecting `'task'`):

```javascript
  if (!['workspace', 'file', 'task'].includes(entityType)) {
    return errorResponse('entity_type must be one of: workspace, file, task', 400)
  }
  if (!entityId) return errorResponse('entity_id is required', 400)
  if (!body || !body.trim()) return errorResponse('body is required', 400)

  // Verify the target actually belongs to this workspace before attaching a
  // comment to it — otherwise a crafted entity_id can associate a comment
  // with another workspace's file/task, or one that doesn't exist at all.
  let taskProjectId = null
  if (entityType === 'workspace') {
    if (entityId !== workspace.id) {
      return errorResponse('entity_id must be this workspace\'s id for entity_type "workspace"', 400)
    }
  } else if (entityType === 'file') {
    const file = await env.DB.prepare('SELECT id FROM files WHERE id = ? AND workspace_id = ?')
      .bind(entityId, workspace.id).first()
    if (!file) return errorResponse('File not found in this workspace', 404)
  } else {
    const task = await env.DB.prepare(
      'SELECT id, project_id FROM tasks WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
    ).bind(entityId, workspace.id).first()
    if (!task) return errorResponse('Task not found in this workspace', 404)
    taskProjectId = task.project_id
  }
```

- [ ] **Step 2:** Update the `link` construction (~line 99) to a three-way branch:

```javascript
  const link = entityType === 'file'
    ? `/workspace/${params.slug}?tab=files&fileId=${entityId}&comments=1`
    : entityType === 'task'
      ? `/workspace/${params.slug}?tab=projects&projectId=${taskProjectId}&taskId=${entityId}`
      : `/workspace/${params.slug}?tab=discussion`
```

Also delete the now-stale comment above the allowlist ("'task' stays out of the request-validation allowlist until Phase 4…").

- [ ] **Step 3: Verify + commit.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
git add worker/src/routes/comments.js
git commit -m "feat(portal): comments accept entity_type 'task' (pre-provisioned in ADR-0004)"
```

---

### Task 6: Worker — /api/me/tasks and /api/me/activity

**Files:**
- Modify: `worker/src/routes/me.js` (append), `worker/src/router.js`

**Interfaces:**
- Consumes: `encodeCursor`/`decodeCursor`/`seekCondition` (already imported in me.js).
- Produces: `GET /api/me/tasks` → `{tasks: [{id, title, status, due_date, project_id, workspace_slug, workspace_name}]}` (max 10). `GET /api/me/activity` → `{activity, next_cursor}` — same shape as the per-workspace endpoint plus `workspace_slug`/`workspace_name` per row. Task 11's Home rewrite consumes both.

- [ ] **Step 1:** Append to `worker/src/routes/me.js`:

```javascript
/** GET /api/me/tasks — self. Open tasks assigned to me across my workspaces,
 * due-soonest first (nulls last), max 10. Includes tasks under paused/archived
 * (non-deleted) projects by design (spec §2). */
export async function handleMyTasks(request, env, user) {
  const userId = user.dbUserId || user.userId
  const conditions = ['t.assignee_id = ?', "t.status != 'done'", 't.deleted_at IS NULL']
  const bindings = [userId]

  if (user.role !== 'admin') {
    if (user.workspaceSlugs.length === 0) return jsonResponse({ tasks: [] })
    const placeholders = user.workspaceSlugs.map(() => '?').join(', ')
    conditions.push(`w.slug IN (${placeholders})`)
    bindings.push(...user.workspaceSlugs)
  }

  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.due_date, t.project_id,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM tasks t INNER JOIN workspaces w ON w.id = t.workspace_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.due_date IS NULL, t.due_date ASC, t.created_at ASC
     LIMIT 10`,
  ).bind(...bindings).all()

  return jsonResponse({ tasks: result.results })
}

/** GET /api/me/activity?limit=&before= — self. audit_log across every
 * workspace the caller belongs to (admins: all), workspace.view excluded,
 * same seek pagination as the per-workspace Activity endpoint. */
export async function handleMyActivity(request, env, user) {
  const url = new URL(request.url)
  const rawLimit = parseInt(url.searchParams.get('limit'), 10)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const before = url.searchParams.get('before')

  const conditions = ['a.workspace_id IS NOT NULL', "a.action != 'workspace.view'"]
  const bindings = []
  if (user.role !== 'admin') {
    conditions.push('a.workspace_id IN (SELECT workspace_id FROM user_workspaces WHERE user_id = ?)')
    bindings.push(user.dbUserId || user.userId)
  }
  if (before) {
    const cursor = decodeCursor(before)
    if (!cursor) return errorResponse('Invalid before cursor', 400)
    const { clause, params: cursorParams } = seekCondition(cursor, 'a.')
    conditions.push(clause)
    bindings.push(...cursorParams)
  }

  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.resource_type, a.resource_id, a.created_at,
            u.username AS actor_username, w.slug AS workspace_slug, w.name AS workspace_name
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id OR u.clerk_id = a.user_id
     INNER JOIN workspaces w ON w.id = a.workspace_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
  ).bind(...bindings, limit).all()

  const activity = result.results
  const nextCursor = activity.length === limit ? encodeCursor(activity[activity.length - 1]) : null

  return jsonResponse({ activity, next_cursor: nextCursor })
}
```

- [ ] **Step 2: Wire the router.** Extend the me.js import block (top of router.js) with `handleMyTasks, handleMyActivity`, and add exact matches next to `/api/me/preferences` (~line 239):

```javascript
        if (pathname === '/api/me/tasks' && method === 'GET') {
          return await handleMyTasks(request, env, user)
        }
        if (pathname === '/api/me/activity' && method === 'GET') {
          return await handleMyActivity(request, env, user)
        }
```

- [ ] **Step 3: Verify + commit.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
git add worker/src/routes/me.js worker/src/router.js
git commit -m "feat(portal): /api/me/tasks + /api/me/activity for the Home widgets"
```

---

### Task 7: Worker — workspace last-activity + delete cascade

**Files:**
- Modify: `worker/src/routes/workspaces.js` (`handleListWorkspaces` ~line 10; `handleDeleteWorkspace` ~line 247)

**Interfaces:**
- Produces: `GET /api/workspaces` rows gain `last_activity_at` (nullable ISO string). Workspace deletion handles `tasks`/`projects`. Task 11's workspace cards consume `last_activity_at`.

- [ ] **Step 1:** In `handleListWorkspaces`, add the correlated subquery to BOTH branches' SELECT (admin and non-admin). Both become:

```sql
SELECT id, name, slug, color, created_at,
  (SELECT MAX(a.created_at) FROM audit_log a
   WHERE a.workspace_id = workspaces.id AND a.action != 'workspace.view') AS last_activity_at
FROM workspaces
```

(admin branch keeps `ORDER BY name`; non-admin branch keeps `WHERE slug IN (${placeholders}) ORDER BY name`.)

- [ ] **Step 2:** In `handleDeleteWorkspace`, insert after the `comments` delete (~line 248) — tasks BEFORE projects (FK `tasks.project_id → projects.id`):

```javascript
  await env.DB.prepare('DELETE FROM tasks WHERE workspace_id = ?').bind(workspace.id).run()
  await env.DB.prepare('DELETE FROM projects WHERE workspace_id = ?').bind(workspace.id).run()
```

Also update that block's explanatory comment to mention tasks/projects joining the explicit-delete list (ADR-0005).

- [ ] **Step 3: Verify + commit.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
git add worker/src/routes/workspaces.js
git commit -m "feat(portal): workspace last_activity_at + tasks/projects in delete cascade"
```

---

### Task 8: API client methods

**Files:**
- Modify: `src/api/client.js` (append after the Notifications section, ~line 197)

**Interfaces:**
- Produces (Tasks 9/10/11 call these exact names): `listProjects(slug)`, `createProject(slug, data)`, `updateProject(id, data)`, `deleteProject(id, force)`, `listTasks(projectId)`, `createTask(projectId, data)`, `updateTask(id, data)`, `deleteTask(id)`, `myTasks()`, `myActivity(params)`.

- [ ] **Step 1:** Append inside the `useMemo` object:

```javascript
    // Projects & tasks (Phase 4)
    listProjects: (slug) => apiFetch(`/api/workspaces/${slug}/projects`, getToken),
    createProject: (slug, data) =>
      apiFetch(`/api/workspaces/${slug}/projects`, getToken, { method: 'POST', body: JSON.stringify(data) }),
    updateProject: (id, data) =>
      apiFetch(`/api/projects/${id}`, getToken, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteProject: (id, force) =>
      apiFetch(`/api/projects/${id}${force ? '?force=1' : ''}`, getToken, { method: 'DELETE' }),
    listTasks: (projectId) => apiFetch(`/api/projects/${projectId}/tasks`, getToken),
    createTask: (projectId, data) =>
      apiFetch(`/api/projects/${projectId}/tasks`, getToken, { method: 'POST', body: JSON.stringify(data) }),
    updateTask: (id, data) =>
      apiFetch(`/api/tasks/${id}`, getToken, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTask: (id) => apiFetch(`/api/tasks/${id}`, getToken, { method: 'DELETE' }),

    // Home widgets (Phase 4)
    myTasks: () => apiFetch('/api/me/tasks', getToken),
    myActivity: (params = {}) =>
      apiFetch(`/api/me/activity?${new URLSearchParams(params)}`, getToken),
```

- [ ] **Step 2: Verify + commit.**

```bash
npm run lint && npm run build
git add src/api/client.js
git commit -m "feat(portal): API client methods for projects, tasks, Home widgets"
```

---

### Task 9: Frontend — Projects tab (list, project page, board/list) + CSS

**Files:**
- Create: `src/components/workspace/ProjectsTab.jsx`
- Modify: `src/pages/WorkspaceDetail.jsx` (tab wiring), `src/components/workspace/ActivityTab.jsx` (labels), `src/pages/WorkspaceDetail.css` (styles)

**Interfaces:**
- Consumes: client methods (Task 8); `TaskDrawer` does NOT exist yet — this task renders the board/list with a `onOpenTask` callback stored in state but the drawer itself mounts in Task 10 (this task leaves `{drawerTask && ...}` rendering nothing via a placeholder `null`; Task 10 replaces it). To keep this task independently shippable, clicking a task card/row is a no-op until Task 10.
- Produces: `<ProjectsTab slug={slug} />` mounted in WorkspaceDetail; `projects` in `WORKSPACE_TABS`. Exposes `STATUS_LABELS` locally (duplicated in TaskDrawer — 3 entries, not worth a shared module).

- [ ] **Step 1:** Create `src/components/workspace/ProjectsTab.jsx`:

```jsx
import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'
import TaskDrawer from '../TaskDrawer'

const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }
const PROJECT_STATUS_LABELS = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' }
const BOARD_COLUMNS = ['todo', 'in_progress', 'done']

function formatDue(dateStr) {
  if (!dateStr) return null
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function ProjectsTab({ slug }) {
  const api = useApiClient()
  const { isAdmin, d1User } = usePortalAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const canWrite = isAdmin || ['write', 'admin'].includes(d1User?.workspacePermissions?.[slug])

  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)      // project object or null (list view)
  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [view, setView] = useState('board')           // 'board' | 'list' — component state only
  const [drawerTask, setDrawerTask] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')

  const loadProjects = useCallback(async () => {
    const data = await api.listProjects(slug)
    return data.projects
  }, [api, slug])

  const loadTasks = useCallback(async (projectId) => {
    const data = await api.listTasks(projectId)
    return data.tasks
  }, [api])

  // Workspace switch: full reset (reused without remounting — Phase 3 lesson).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSelected(null)
    setTasks([])
    setDrawerTask(null)
    loadProjects()
      .then((p) => { if (!cancelled) setProjects(p) })
      .catch(() => { if (!cancelled) setError('Could not load projects.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadProjects])

  // Consume the projectId/taskId deep-link params (pinned shape, spec §3),
  // once, after the project list has loaded — same consume-and-strip pattern
  // as WorkspaceDetail's fileId/comments handling.
  useEffect(() => {
    const projectId = searchParams.get('projectId')
    if (!projectId || loading) return
    const project = projects.find((p) => p.id === projectId)
    const taskId = searchParams.get('taskId')
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('projectId')
      next.delete('taskId')
      return next
    }, { replace: true })
    if (!project) return   // stale link (project deleted / no access) — fail silently
    openProject(project, taskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, projects, searchParams])

  const openProject = async (project, focusTaskId = null) => {
    setSelected(project)
    setTasksLoading(true)
    try {
      const t = await loadTasks(project.id)
      setTasks(t)
      if (focusTaskId) {
        const target = t.find((x) => x.id === focusTaskId)
        if (target) setDrawerTask(target)
      }
    } catch {
      setError('Could not load tasks.')
    } finally {
      setTasksLoading(false)
    }
  }

  const refreshTasks = async () => {
    if (!selected) return
    try { setTasks(await loadTasks(selected.id)) } catch { /* keep stale list */ }
  }

  const createProject = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await api.createProject(slug, { name: newName.trim() })
      setNewName('')
      setProjects(await loadProjects())
    } catch (err) {
      setError(err.data?.error || 'Could not create project.')
    } finally {
      setCreating(false)
    }
  }

  const createTask = async () => {
    if (!newTaskTitle.trim() || !selected) return
    try {
      await api.createTask(selected.id, { title: newTaskTitle.trim() })
      setNewTaskTitle('')
      await refreshTasks()
    } catch (err) {
      setError(err.data?.error || 'Could not create task.')
    }
  }

  const changeTaskStatus = async (task, status) => {
    try {
      await api.updateTask(task.id, { status })
      await refreshTasks()
    } catch (err) {
      setError(err.data?.error || 'Could not update task.')
    }
  }

  const changeProjectStatus = async (status) => {
    if (!selected) return
    try {
      await api.updateProject(selected.id, { status })
      setSelected({ ...selected, status })
      setProjects(await loadProjects())
    } catch (err) {
      setError(err.data?.error || 'Could not update project.')
    }
  }

  const deleteProject = async () => {
    if (!selected) return
    if (!confirm(`Delete project "${selected.name}"?`)) return
    try {
      await api.deleteProject(selected.id)
      setSelected(null)
      setProjects(await loadProjects())
    } catch (err) {
      if (err.status === 409) {
        if (confirm(`${err.data?.error || 'Project has open tasks.'}\n\nDelete them too?`)) {
          await api.deleteProject(selected.id, true)
          setSelected(null)
          setProjects(await loadProjects())
        }
      } else {
        setError(err.data?.error || 'Could not delete project.')
      }
    }
  }

  if (loading) return <div className="projects-tab__loading"><div className="spinner" /></div>

  // ── Project list ──
  if (!selected) {
    return (
      <div className="projects-tab">
        {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
        {canWrite && (
          <div className="projects-tab__new">
            <input
              type="text"
              value={newName}
              placeholder="New project name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button className="btn btn--primary" onClick={createProject} disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'New project'}
            </button>
          </div>
        )}
        {projects.length === 0 ? (
          <div className="projects-tab__empty">No projects yet.</div>
        ) : (
          <div className="projects-tab__grid">
            {projects.map((p) => (
              <button key={p.id} className="project-card card" onClick={() => openProject(p)}>
                <div className="project-card__name">{p.name}</div>
                <div className="project-card__meta">
                  <span className={`badge project-card__status--${p.status}`}>{PROJECT_STATUS_LABELS[p.status]}</span>
                  <span className="mono">{p.open_task_count} open · {p.done_task_count} done</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Project page ──
  const columns = BOARD_COLUMNS.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status === status),
  }))

  return (
    <div className="projects-tab">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
      <div className="project-page__header">
        <button className="link-btn" onClick={() => { setSelected(null); setDrawerTask(null) }}>← Projects</button>
        <h3>{selected.name}</h3>
        {canWrite ? (
          <select
            className="ops-filter-select"
            value={selected.status}
            onChange={(e) => changeProjectStatus(e.target.value)}
          >
            {Object.entries(PROJECT_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ) : (
          <span className="badge">{PROJECT_STATUS_LABELS[selected.status]}</span>
        )}
        <div className="project-page__actions">
          <button
            className={`btn btn--secondary btn--sm ${view === 'board' ? 'project-page__view--active' : ''}`}
            onClick={() => setView('board')}
          >Board</button>
          <button
            className={`btn btn--secondary btn--sm ${view === 'list' ? 'project-page__view--active' : ''}`}
            onClick={() => setView('list')}
          >List</button>
          {(isAdmin || d1User?.workspacePermissions?.[slug] === 'admin' || selected.created_by === d1User?.userId) && (
            <button className="btn btn--danger btn--sm" onClick={deleteProject}>Delete</button>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="projects-tab__new">
          <input
            type="text"
            value={newTaskTitle}
            placeholder="New task title"
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createTask()}
          />
          <button className="btn btn--secondary btn--sm" onClick={createTask} disabled={!newTaskTitle.trim()}>
            Add task
          </button>
        </div>
      )}

      {tasksLoading ? (
        <div className="projects-tab__loading"><div className="spinner" /></div>
      ) : view === 'board' ? (
        <div className="task-board">
          {columns.map((col) => (
            <div key={col.status} className="task-board__column">
              <div className="task-board__column-title label">
                {STATUS_LABELS[col.status]} <span className="mono">{col.tasks.length}</span>
              </div>
              {col.tasks.map((t) => (
                <div key={t.id} className="task-card" onClick={() => setDrawerTask(t)}>
                  <div className="task-card__title">{t.title}</div>
                  <div className="task-card__meta">
                    {t.assignee_username && <span className="task-card__assignee mono">{t.assignee_username}</span>}
                    {t.due_date && <span className="task-card__due mono">{formatDue(t.due_date)}</span>}
                    {t.comment_count > 0 && <span className="task-card__comments mono">💬 {t.comment_count}</span>}
                  </div>
                  {canWrite && (
                    <select
                      className="ops-filter-select task-card__status"
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => changeTaskStatus(t, e.target.value)}
                    >
                      {BOARD_COLUMNS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </select>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Assignee</th><th>Due</th><th>Status</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="folder-row" onClick={() => setDrawerTask(t)}>
                <td>{t.title}</td>
                <td className="mono">{t.assignee_username || '—'}</td>
                <td className="mono">{formatDue(t.due_date) || '—'}</td>
                <td><span className="badge">{STATUS_LABELS[t.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {drawerTask && (
        <TaskDrawer
          workspaceSlug={slug}
          task={drawerTask}
          canWrite={canWrite}
          onClose={() => setDrawerTask(null)}
          onChanged={refreshTasks}
        />
      )}
    </div>
  )
}
```

**NOTE:** this file imports `TaskDrawer` which Task 10 creates. To keep THIS task buildable on its own, Task 9 also creates a minimal stub at `src/components/TaskDrawer.jsx` that Task 10 replaces wholesale:

```jsx
// Placeholder — replaced by Task 10 with the full drawer.
export default function TaskDrawer() {
  return null
}
```

- [ ] **Step 2:** Wire into `src/pages/WorkspaceDetail.jsx`:

Line 70: `const WORKSPACE_TABS = ['files', 'projects', 'discussion', 'activity', 'members']`

Add the import: `import ProjectsTab from '../components/workspace/ProjectsTab'`

Tab bar (~line 443), after the Files button:

```jsx
        <button className={`workspace__tab ${activeTab === 'projects' ? 'workspace__tab--active' : ''}`} onClick={() => changeTab('projects')}>Projects</button>
```

Tab body (~line 452), alongside the others:

```jsx
      {activeTab === 'projects' && <ProjectsTab slug={slug} />}
```

- [ ] **Step 3:** Add labels in `src/components/workspace/ActivityTab.jsx`'s `describeAction` map:

```javascript
    'project.create': 'created a project',
    'project.update': 'updated a project',
    'project.delete': 'deleted a project',
    'task.create': 'created a task',
    'task.update': 'edited a task',
    'task.status': 'moved a task',
    'task.delete': 'deleted a task',
```

- [ ] **Step 4:** Append to `src/pages/WorkspaceDetail.css`:

```css
/* ── Projects Tab (Phase 4) ── */

.projects-tab {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.projects-tab__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
}

.projects-tab__empty {
  padding: 1.5rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.projects-tab__new {
  display: flex;
  gap: 0.5rem;
}

.projects-tab__new input {
  flex: 1;
  padding: 0.5rem 0.8rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.85rem;
  outline: none;
}

.projects-tab__new input:focus {
  border-color: var(--accent);
}

.projects-tab__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.8rem;
}

.project-card {
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
}

.project-card__name {
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}

.project-card__meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.7rem;
  color: var(--text-muted);
}

.project-card__status--paused { color: var(--warning); background: rgba(230, 165, 26, 0.1); }
.project-card__status--done { color: var(--success); background: rgba(76, 154, 107, 0.1); }
.project-card__status--archived { color: var(--text-muted); background: var(--bg-elevated); }

.project-page__header {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex-wrap: wrap;
}

.project-page__header h3 {
  margin: 0;
}

.project-page__actions {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}

.project-page__view--active {
  border-color: var(--accent);
  color: var(--accent);
}

.task-board {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.8rem;
  align-items: start;
}

.task-board__column {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 120px;
}

.task-board__column-title {
  display: flex;
  justify-content: space-between;
  padding: 0.2rem 0.2rem 0.4rem;
}

.task-card {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.6rem 0.7rem;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.task-card:hover {
  border-color: var(--border-strong);
}

.task-card__title {
  font-size: 0.82rem;
  color: var(--text-primary);
  margin-bottom: 0.3rem;
}

.task-card__meta {
  display: flex;
  gap: 0.6rem;
  font-size: 0.65rem;
  color: var(--text-muted);
}

.task-card__status {
  margin-top: 0.4rem;
  width: 100%;
}

@media (max-width: 768px) {
  .task-board {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 5: Verify + commit.**

```bash
npm test && npm run lint && npm run build
git add src/components/workspace/ProjectsTab.jsx src/components/TaskDrawer.jsx src/pages/WorkspaceDetail.jsx src/components/workspace/ActivityTab.jsx src/pages/WorkspaceDetail.css
git commit -m "feat(portal): Projects tab — list, project page, board/list views"
```

---

### Task 10: Frontend — TaskDrawer + Settings label + CSS

**Files:**
- Modify (replace stub): `src/components/TaskDrawer.jsx`
- Modify: `src/components/workspace/WorkspaceSettingsTab.jsx` (label), `src/pages/WorkspaceDetail.css` (drawer styles)

**Interfaces:**
- Consumes: `CommentThread` (`entityType="task"` — backend admits it since Task 5); `api.listMembers(slug)` (Phase 2) for the assignee select; `api.updateTask`/`api.deleteTask` (Task 8). Props contract (from Task 9): `{workspaceSlug, task, canWrite, onClose, onChanged}`.

- [ ] **Step 1:** Replace `src/components/TaskDrawer.jsx` wholesale:

```jsx
import { useState, useEffect } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import CommentThread from './CommentThread'

const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }

export default function TaskDrawer({ workspaceSlug, task, canWrite, onClose, onChanged }) {
  const api = useApiClient()
  const { isAdmin, d1User } = usePortalAuth()
  const [members, setMembers] = useState([])
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description || '')
  const [status, setStatus] = useState(task.status)
  const [assigneeId, setAssigneeId] = useState(task.assignee_id || '')
  const [dueDate, setDueDate] = useState(task.due_date || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const canDelete = isAdmin
    || d1User?.workspacePermissions?.[workspaceSlug] === 'admin'
    || task.created_by === d1User?.userId

  // Task identity change (drawer reused for another task without remount).
  useEffect(() => {
    setTitle(task.title)
    setDescription(task.description || '')
    setStatus(task.status)
    setAssigneeId(task.assignee_id || '')
    setDueDate(task.due_date || '')
    setError(null)
  }, [task.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    api.listMembers(workspaceSlug)
      .then((data) => { if (!cancelled) setMembers(data.members || []) })
      .catch(() => { /* select degrades to current assignee only */ })
    return () => { cancelled = true }
  }, [api, workspaceSlug])

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.updateTask(task.id, {
        title: title.trim(),
        description: description.trim() || null,
        status,
        assignee_id: assigneeId || null,
        due_date: dueDate || null,
      })
      await onChanged()
      onClose()
    } catch (err) {
      setError(err.data?.error || 'Could not save task.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete task "${task.title}"?`)) return
    try {
      await api.deleteTask(task.id)
      await onChanged()
      onClose()
    } catch (err) {
      setError(err.data?.error || 'Could not delete task.')
    }
  }

  return (
    <div className="slide-over-overlay" onClick={onClose}>
      <div className="slide-over" onClick={(e) => e.stopPropagation()}>
        <div className="slide-over__header">
          <h3>{task.title}</h3>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>

        {error && <div className="workspace__alert workspace__alert--error">{error}</div>}

        {canWrite ? (
          <div className="task-drawer__fields">
            <label className="label">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label className="label">Description</label>
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            <label className="label">Status</label>
            <select className="ops-filter-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="label">Assignee</label>
            <select className="ops-filter-select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.username}</option>)}
            </select>
            <label className="label">Due date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <div className="task-drawer__actions">
              {canDelete && <button className="btn btn--danger btn--sm" onClick={remove}>Delete</button>}
              <button className="btn btn--primary" onClick={save} disabled={saving || !title.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="task-drawer__fields task-drawer__fields--readonly">
            {task.description && <p className="task-drawer__description">{task.description}</p>}
            <div className="task-drawer__row mono">
              <span className="badge">{STATUS_LABELS[task.status]}</span>
              {task.assignee_username && <span>{task.assignee_username}</span>}
              {task.due_date && <span>due {task.due_date}</span>}
            </div>
          </div>
        )}

        <div className="task-drawer__comments">
          <span className="label">Comments</span>
          <CommentThread workspaceSlug={workspaceSlug} entityType="task" entityId={task.id} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2:** In `src/components/workspace/WorkspaceSettingsTab.jsx` (~line 84), change the radio option label:

```javascript
          { value: 'mentions', label: 'Mentions & assignments' },
```

- [ ] **Step 3:** Append to `src/pages/WorkspaceDetail.css`:

```css
/* ── Task Drawer (Phase 4) ── */

.task-drawer__fields {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
  margin-bottom: 1.2rem;
}

.task-drawer__fields input[type="text"],
.task-drawer__fields input[type="date"],
.task-drawer__fields textarea,
.task-drawer__fields select {
  width: 100%;
  padding: 0.5rem 0.7rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.85rem;
  outline: none;
}

.task-drawer__fields input:focus,
.task-drawer__fields textarea:focus,
.task-drawer__fields select:focus {
  border-color: var(--accent);
}

.task-drawer__actions {
  display: flex;
  gap: 0.6rem;
  align-self: flex-end;
  margin-top: 0.4rem;
}

.task-drawer__description {
  font-size: 0.85rem;
  color: var(--text-primary);
  white-space: pre-wrap;
}

.task-drawer__row {
  display: flex;
  gap: 0.8rem;
  align-items: center;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.task-drawer__comments {
  border-top: 1px solid var(--border);
  padding-top: 0.8rem;
}
```

- [ ] **Step 4: Verify + commit.**

```bash
npm test && npm run lint && npm run build
git add src/components/TaskDrawer.jsx src/components/workspace/WorkspaceSettingsTab.jsx src/pages/WorkspaceDetail.css
git commit -m "feat(portal): task detail drawer with comments; Mentions & assignments label"
```

---

### Task 11: Frontend — Home redesign + version bump + CSS-coverage check

**Files:**
- Modify: `src/pages/Home.jsx`, `src/pages/Dashboard.css`, `package.json`

**Interfaces:**
- Consumes: `api.myTasks()`, `api.myActivity()` (Tasks 6/8); `last_activity_at` on workspaces (Task 7). Deep-links use the pinned shape.

- [ ] **Step 1:** Rework `src/pages/Home.jsx`:

1. Extend `actionLabel`'s map with the same seven project/task labels as ActivityTab (Task 9 Step 3) plus `'comment.create': 'commented'`, `'member.invite': 'invited a member'`, `'member.join': 'joined a workspace'`.
2. Load the two new sources alongside the existing ones — replace the `load()` body:

```jsx
        const [wsData, tasksData, activityData, analyticsData] = await Promise.all([
          api.listWorkspaces(),
          api.myTasks().catch(() => ({ tasks: [] })),
          api.myActivity({ limit: '8' }).catch(() => ({ activity: [] })),
          isAdmin ? api.getAnalytics() : Promise.resolve(null),
        ])
        setWorkspaces(wsData.workspaces || [])
        setMyTasks(tasksData.tasks || [])
        setActivity(activityData.activity || [])
        if (analyticsData) setAnalytics(analyticsData)
```

with new state hooks `const [myTasks, setMyTasks] = useState([])` and `const [activity, setActivity] = useState([])`, and `import { Link } from 'react-router-dom'` already present.

3. Insert the **My Tasks widget** between the header and the workspace grid:

```jsx
      {myTasks.length > 0 && (
        <div className="my-tasks">
          <span className="label">My Tasks</span>
          <div className="my-tasks__list stagger-in">
            {myTasks.map((t) => (
              <Link
                key={t.id}
                className="my-tasks__item"
                to={`/workspace/${t.workspace_slug}?tab=projects&projectId=${t.project_id}&taskId=${t.id}`}
              >
                <span className="my-tasks__title">{t.title}</span>
                <span className="my-tasks__workspace mono">{t.workspace_name}</span>
                <span className="my-tasks__due mono">{t.due_date || 'No due date'}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
```

4. **Workspace cards** gain a last-activity line (inside the existing card, after `workspace-card__meta`):

```jsx
              {ws.last_activity_at && (
                <div className="workspace-card__activity mono">updated {formatTime(ws.last_activity_at)}</div>
              )}
```

5. **Recent Activity strip** — replace the `analytics?.recentActivity` source with the universal `activity` state (rendering stays the same shape; add the workspace name):

```jsx
          {activity.length > 0 ? (
            activity.map((entry) => (
              <div key={entry.id} className="activity-item">
                <span className="activity-item__user mono">{entry.actor_username || 'system'}</span>
                <span className="activity-item__action">{actionLabel(entry.action)}</span>
                <span className="activity-item__workspace mono">{entry.workspace_name}</span>
                <span className="activity-item__time mono">{formatTime(entry.created_at)}</span>
              </div>
            ))
          ) : (
            <div className="activity-empty">No activity yet.</div>
          )}
```

The `dashboard__activity` block moves OUTSIDE the `isAdmin && analytics` conditional (it's universal now); the stats row (`dashboard__stats`) stays admin-gated exactly as-is.

- [ ] **Step 2:** Append to `src/pages/Dashboard.css`:

```css
/* ── My Tasks (Phase 4) ── */

.my-tasks {
  margin-bottom: 2rem;
}

.my-tasks__list {
  display: flex;
  flex-direction: column;
  margin-top: 0.5rem;
}

.my-tasks__item {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.55rem 0.2rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-primary);
  text-decoration: none;
  font-size: 0.85rem;
  transition: background 0.12s ease;
}

.my-tasks__item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.my-tasks__item:last-child {
  border-bottom: none;
}

.my-tasks__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.my-tasks__workspace {
  font-size: 0.7rem;
  color: var(--accent);
}

.my-tasks__due {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.workspace-card__activity {
  margin-top: 0.3rem;
  font-size: 0.65rem;
  color: var(--text-muted);
}

.activity-item__workspace {
  font-size: 0.7rem;
  color: var(--accent);
}
```

- [ ] **Step 3:** Bump `package.json` version: `"version": "0.6.0"`.

- [ ] **Step 4: CSS-coverage check (PR #34 lesson — do not skip).** Every class the new components reference must resolve to a rule:

```bash
cd src && for cls in projects-tab projects-tab__loading projects-tab__empty projects-tab__new projects-tab__grid project-card project-card__name project-card__meta project-page__header project-page__actions project-page__view--active task-board task-board__column task-board__column-title task-card task-card__title task-card__meta task-card__status task-drawer__fields task-drawer__actions task-drawer__description task-drawer__row task-drawer__comments my-tasks my-tasks__list my-tasks__item my-tasks__title my-tasks__workspace my-tasks__due workspace-card__activity activity-item__workspace task-card__assignee task-card__due task-card__comments task-drawer__fields--readonly project-page__description project-page__edit project-page__edit-actions; do
  grep -rql "\.${cls}[^a-zA-Z0-9_-]" --include="*.css" . || echo "MISSING: $cls"
done; cd ..
```

Expected: NO `MISSING:` lines.

- [ ] **Step 5: Full verify + commit.**

```bash
npm test && npm run lint && npm run build
cd worker && npx wrangler deploy --dry-run && cd ..
git add src/pages/Home.jsx src/pages/Dashboard.css package.json
git commit -m "feat(portal): Home redesign — My Tasks, last-activity cards, universal activity strip; v0.6.0"
```

---

## After the last task

- Push `feat/portal-phase4-projects-tasks` and open the PR **only when explicitly asked** (standing convention).
- **NOT in this plan:** applying migration 008 to remote D1, `wrangler deploy`, `pages deploy` — deploy is a separate, explicitly-requested step after merge.
- Live-ceiling tests post-deploy (spec §5): read-only member 403 on create/edit; non-creator non-admin 403 on delete; 409-then-force project delete soft-deletes open tasks; Chris assigns → Russ gets My Tasks entry + bell/inbox (+email per pref, now including `mentions` tier); Chris marks it done → Russ notified, task drops off My Tasks, both events visible in the workspace Activity tab.
