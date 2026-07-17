# PORTAL_OVERHAUL_PLAN.md — portal.warsignallabs.net v0.2.2 → v1.0

**Date:** 2026-07-17
**Author:** Claude (Fable) — planning session with Russ
**Status:** DRAFT — awaiting Russ approval
**Executor:** Sonnet (phase-by-phase; each phase is one PR)
**Prereq reading for executor:** `portal-app/CONTEXT.md`, `portal-app/AGENTS.md`, `portal-app/memory.yaml`, `portal-app/handoff.yaml`, root `CONTEXT.md` (Brand & Voice section is load-bearing)

---

## 1. Why this overhaul

The portal today is a **secure file locker**: workspaces, folder browser, file versioning,
RBAC, audit log, email notifications. It is not a **collaboration space**. Russ and Chris
DePalma (Blueprint Advisory) need to collaborate on many projects — discuss work, track
tasks, see what changed, and manage their own workspaces without Russ hand-editing D1.

Current gaps, in priority order:

1. **Chris cannot log in at all.** The Clerk dev instance (`sharing-gator-67.clerk.accounts.dev`)
   relies on third-party cookies that modern browsers block. The fix — Clerk production
   instance on `clerk.warsignallabs.net` — is fully planned in `handoff.yaml` (6 phases)
   and blocked on Russ dashboard actions. **Nothing else matters until this ships.**
2. **No collaboration primitives.** No comments, no tasks/projects, no per-workspace
   activity feed, no in-app notifications. The only "collaboration" is uploading a file
   and receiving an email.
3. **No self-service workspace/permission management.** Only global `admin` can create
   workspaces or assign members, and only from the Admin pages. Chris (role `client`)
   can do nothing but browse files. The `owner` role exists in the enum but is unused.
4. **UI diverges from the brand.** The marketing site moved to the executive identity
   (IBM Plex, navy `#0E1726`, steel-blue `#6F8FB8`, gold `#C9A557`) in the 2026-05-05
   overhaul. The portal still runs the old cyberpunk theme: neon cyan `#00c8d4`, neon
   green `#39ff14`, Share Tech Mono, `[ MENU ]` toggle, `// Dashboard` kickers. This is
   open backlog item P1-10 and it matters because the portal is a **live demo of
   consulting capability** — Chris is both collaborator and prospective referrer.
5. **Maintainability debt.** `worker/index.js` is a 2,607-line monolith. No D1 migration
   discipline (schema changes have been ad-hoc `wrangler d1 execute`). No tests.
   Version badge hardcoded `v0.2.0` in `PortalLayout.jsx` while the release is v0.2.2;
   `package.json` still says `0.0.0`.

## 2. Approaches considered

| Approach | Verdict |
|---|---|
| **A. Incremental uplift of the existing stack** (React + Worker + D1 + R2 + Clerk) — refactor, retheme, extend with collaboration tables and endpoints | **RECOMMENDED.** The auth/RBAC/audit/versioning core is proven and D1-authoritative by design. Two active users; free tier everywhere; no scale pressure. Every phase ships independently. |
| B. Rebuild on a full-stack framework (Next.js / Remix / SvelteKit on Cloudflare) | Rejected. Throws away a working, hardened Worker (JWT/JWKS verification, RBAC, audit, Resend integration) for zero user-visible gain. Higher risk, longer dark period. |
| C. Buy, don't build — run collaboration in Notion/Linear, keep portal as file exchange | Rejected. Defeats the portal's second purpose: a white-label-able showcase that could be replicated for Chris's own clients. Client-facing data also stays under WSL's own infra/audit. |

Real-time infrastructure (WebSockets / Durable Objects) is **explicitly out of scope** for
v1.0 — with two users, refetch-on-navigation plus a 60s poll on the notification bell is
indistinguishable from real-time and stays on the free tier.

## 3. Target design

### 3.1 Roles & permissions (the "permissions" feature)

Keep the existing two-level model — global role + per-workspace permission — but activate
the dormant `owner` role and push management into the workspace UI.

**Global roles** (`users.role`):

| Role | Capabilities |
|---|---|
| `admin` (Russ) | Everything, everywhere. Admin pages, all workspaces, user management, audit log, ops dashboard. |
| `owner` (Chris — **promote from `client`**; display name in UI: **"Collaborator"**) | Create workspaces (auto-granted `admin` permission on those). Member/permission management ONLY on workspaces where they hold `admin` permission (i.e., ones they created or were explicitly granted). No global admin pages, no ops dashboard, no user role changes. **Hard ceilings (see below): can never delete a workspace, never delete files outside their own admin-permission workspaces, and never touch content in workspaces they aren't a member of.** |
| `client` | Sees only assigned workspaces, acts within per-workspace permission. |

**Per-workspace permission** (`user_workspaces.permission`) — unchanged tiers, now with teeth:

| Permission | Grants |
|---|---|
| `read` | View/download files, read comments, view projects/tasks, view activity |
| `write` | read + upload/replace/move files, folder CRUD, post comments, create/edit tasks & projects |
| `admin` | write + invite/remove members, change member permissions, rename workspace, workspace settings |

**Destructive-action ceilings (non-negotiable, per Russ 2026-07-17).** The `owner` role
must never be able to destroy the global admin's content or infrastructure:

| Action | Who can do it |
|---|---|
| Delete a workspace (`DELETE /api/workspaces/:slug`) | **Global `admin` only — always.** Never owners, even on workspaces they created. |
| Delete a file (`DELETE /api/files/:id`) | Global admin anywhere; owner ONLY in workspaces where they hold `admin` permission. Never in workspaces where they have `read`/`write` (e.g., Chris in `warsignallabs` or `blueprint-advisory` as granted by Russ). |
| Delete a non-empty folder | Same rule as file delete (empty-folder delete stays a `write` capability, as today). |
| Remove a member or downgrade a permission | Workspace-admin only, and NEVER against a global `admin` — a global admin cannot be removed, downgraded, or locked out of any workspace by an owner. |
| Change a user's global role, deactivate a user | Global admin only. |
| Hard-delete comments/tasks/projects created by others | Soft-delete only, and only within the owner's admin-permission workspaces; global admin can always restore from audit trail context. |

File versioning already makes replace non-destructive (old versions archived). Every
delete path must check these ceilings server-side in the Worker — UI hiding is not
enforcement. Phase 2 tests must include: owner attempting each ceiling action against a
Russ-owned workspace → 403 + audit_log entry.

Enforcement stays **D1-authoritative in the Worker** (never Clerk metadata). Every new
mutation endpoint writes an `audit_log` row — same discipline as the file endpoints.

### 3.2 New collaboration features

1. **Workspace Add** — "New workspace" button (admin + owner). Creates workspace, assigns
   creator as `admin`-permission member, redirects into it. Extends the existing
   `POST /api/workspaces` (currently admin-only) to allow `owner`.
2. **Members & Permissions panel** — a "Members" tab inside each workspace (visible to all
   members; edit controls only for workspace-admin). List members with permission chips;
   change permission; remove member; **invite by email**.
   *Invitation model that fits passwordless Clerk:* inviting `chris@x.com` creates a
   `users` row (`status='invited'`) + `user_workspaces` row + a Resend email with a link
   to the portal. On first sign-in, the Worker's existing email auto-map in `requireAuth`
   attaches the Clerk identity and flips status to `active`. No Clerk API dependency.
3. **Comments** — threaded discussion (one reply level) on two entity types at launch:
   workspace ("Discussion" tab) and file (side panel in the file browser). Markdown-lite
   rendering (bold/italic/links/code — sanitize, no raw HTML).
4. **Projects & tasks** — the "collaborate on many different projects" core. A workspace
   contains projects; a project contains tasks. Task = title, description, status
   (`todo` / `in_progress` / `done`), assignee (workspace member), due date. Board view
   (3 columns) + list view. Comments attach to tasks too (third entity type).
5. **Activity feed** — per-workspace "Activity" tab rendering `audit_log` scoped to that
   workspace (uploads, comments, task changes, member changes), and a cross-workspace
   "Recent activity" strip on Home.
6. **In-app notification center** — bell icon in the topnav, unread count, dropdown list,
   mark-as-read; backed by a `notification_inbox` table. Written in the same code path
   that currently sends Resend emails. Per-user email preference: `all` (default) /
   `mentions & assignments only` / `none` — in-app entries always written.
7. **Dashboard (Home) redesign** — "My tasks" (assigned to me, due soonest first),
   workspace cards with last-activity, recent activity strip, storage stats (admin only).

### 3.3 UI / theme overhaul

Replace `src/themes/dark-professional.css` with `src/themes/executive.css` derived from
the marketing site's tokens (root `styles.css`), keeping the portal dark:

| Token | Old (cyberpunk) | New (executive) |
|---|---|---|
| Ground | `#0a1628` | `#0E1726` |
| Surface / elevated | `#0c1f3a` / `#112240` | `#141F31` / `#1A2740` |
| Accent | neon cyan `#00c8d4` | steel-blue `#6F8FB8` |
| Primary CTA | neon cyan | burnished gold `#C9A557` (primary buttons only) |
| Success | neon green `#39ff14` | muted green `#4C9A6B` |
| Warning / error | `#ffaa00` / `#ff4d4d` | keep hues, desaturate ~20% |
| Fonts | Inter / DM Sans / **Share Tech Mono** | IBM Plex Sans / IBM Plex Serif (headings) / IBM Plex Mono (data only) |

Kill-list (grep must return zero in `portal-app/src` after Phase 1): `[ MENU ]`,
`[ CLOSE ]`, `// `-prefixed kickers (e.g. `// Dashboard` in `Home.jsx`), Share Tech Mono,
`#39ff14`, `#00c8d4`. Hamburger becomes a standard icon; kickers become plain
small-caps labels (the `.label` class, restyled). Tone in UI copy follows the root
`CONTEXT.md` Brand & Voice rules: measured, plain, declarative.

Layout stays sidebar + topnav. Sidebar gains: notification bell (topnav), "New workspace"
button for admin/owner, and per-workspace sub-nav appears as tabs inside the workspace
page (Files · Projects · Discussion · Activity · Members) rather than nesting the sidebar.

### 3.4 Schema additions (D1)

```sql
-- 001_migrations_table.sql (Phase 1)
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 002_collab_core.sql (Phase 2)
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,               -- inv-<nanoid>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read','write','admin')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'   -- pending | accepted | revoked
    CHECK (status IN ('pending','accepted','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
-- users.status gains 'invited' as a valid value (app-level; column is TEXT already)

-- 003_comments_notifications.sql (Phase 3)
CREATE TABLE comments (
  id TEXT PRIMARY KEY,               -- cmt-<nanoid>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('workspace','file','task')),
  entity_id TEXT NOT NULL,           -- workspace_id | file_id | task_id
  parent_comment_id TEXT REFERENCES comments(id),   -- one level deep only (enforce in API)
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,                -- markdown-lite source
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT,
  deleted_at TEXT                    -- soft delete; render as "[deleted]"
);
CREATE INDEX idx_comments_entity ON comments(workspace_id, entity_type, entity_id);

CREATE TABLE notification_inbox (
  id TEXT PRIMARY KEY,               -- ntf-<nanoid>
  user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,          -- reuse existing event names + comment.create, task.assign, ...
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                         -- in-app route, e.g. /workspace/blueprint-advisory?tab=discussion
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox_user ON notification_inbox(user_id, read_at);

ALTER TABLE users ADD COLUMN email_pref TEXT NOT NULL DEFAULT 'all'; -- all | mentions | none

-- 004_projects_tasks.sql (Phase 4)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,               -- prj-<nanoid>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,               -- tsk-<nanoid>
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),   -- denormalized for permission checks
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status, sort_order);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);
```

Note: the existing `dashboard/projects` (ops dashboard, `data/projects.json`) is an
**unrelated admin feature** (GW-OS ops). The new `projects` table is workspace-scoped
collaboration. Keep names distinct in code: `opsProjects` vs `projects`.

### 3.5 New API endpoints

All authenticated, all D1-authoritative, all mutations audited. `wsAdmin` = caller has
`admin` permission on the workspace or is global admin; `wsWrite` similarly.

```
# Members & invitations (Phase 2)
GET    /api/workspaces/:slug/members                  (member)
PATCH  /api/workspaces/:slug/members/:userId          (wsAdmin)   body: {permission}
DELETE /api/workspaces/:slug/members/:userId          (wsAdmin; can NEVER target a global admin; cannot remove last admin-permission member)
POST   /api/workspaces/:slug/invitations              (wsAdmin)   body: {email, permission}
GET    /api/workspaces/:slug/invitations              (wsAdmin)
DELETE /api/invitations/:id                           (wsAdmin)   -- revoke
POST   /api/workspaces                                (EXTEND: allow role owner; creator auto-membership permission=admin)

# Comments (Phase 3)
GET    /api/workspaces/:slug/comments?entity_type=&entity_id=   (member)
POST   /api/workspaces/:slug/comments                 (wsWrite)  body: {entity_type, entity_id, parent_comment_id?, body}
PATCH  /api/comments/:id                              (author or global admin)
DELETE /api/comments/:id                              (author, wsAdmin, or global admin — soft delete)

# Notifications (Phase 3)
GET    /api/notifications?unread=1                    (self)
POST   /api/notifications/mark-read                   (self)     body: {ids: [...]} or {all: true}
PATCH  /api/me/preferences                            (self)     body: {email_pref}

# Activity (Phase 3)
GET    /api/workspaces/:slug/activity?limit=50&before= (member)  -- audit_log scoped to workspace

# Projects & tasks (Phase 4)
GET    /api/workspaces/:slug/projects                 (member)
POST   /api/workspaces/:slug/projects                 (wsWrite)
PATCH  /api/projects/:id                              (wsWrite)
DELETE /api/projects/:id                              (wsAdmin; blocks if tasks exist unless ?force=1, which archives)
GET    /api/projects/:id/tasks                        (member)
POST   /api/projects/:id/tasks                        (wsWrite)
PATCH  /api/tasks/:id                                 (wsWrite)  -- status/assignee/due/sort_order/title/description
DELETE /api/tasks/:id                                 (wsWrite)
```

New notification events: `comment.create`, `comment.mention` (`@username` parsing),
`task.assign`, `task.status`, `member.invite`, `member.join`, `member.permission_change`.
Recipients follow the existing pattern (admins always; workspace members; actor excluded)
with the new `email_pref` filter applied to email only, never to inbox rows.

## 4. Phased execution plan

Each phase = one branch + one PR, deployable and demoable on its own. Worker and Pages
deploy commands are in `CONTEXT.md`. Bump the version badge and `package.json` each phase.

### Phase 0 — Clerk production migration (GATE — mostly Russ)
Already fully specified in `portal-app/handoff.yaml` (6 sub-phases). Russ performs the
Clerk dashboard steps (create production instance via clone-from-dev, custom domain
`clerk.warsignallabs.net`, emit CNAMEs + `pk_live_`); agent does DNS, code changes
(`wrangler.toml` line 28, `.env`, `public/_headers` CSP), cutover deploys, verification.
**Exit criterion: Chris signs in successfully.** Code phases 1–5 below can proceed in
parallel; nothing in them touches auth.

### Phase 1 — Foundation: refactor + retheme (no behavior change) → v0.3.0
1. **Modularize the Worker.** Split `worker/index.js` into ES modules:
   `worker/src/{router.js, auth.js, cors.js, audit.js, notify.js}` and
   `worker/src/routes/{me,workspaces,folders,files,users,admin,briefs}.js`;
   `index.js` becomes a thin entry. Pure move — endpoint behavior byte-identical
   (verify with a before/after smoke script hitting every GET endpoint).
2. **D1 migration scaffold.** `worker/migrations/*.sql` (numbered), `schema_migrations`
   table, and `npm run migrate` script that applies pending files via
   `wrangler d1 execute wsl-portal --remote --file`. Backfill `000_baseline.sql`
   documenting the current schema (no-op on prod).
3. **Retheme.** New `src/themes/executive.css` per §3.3; delete cyberpunk tokens;
   kill-list grep clean; replace `[ MENU ]` with an icon; restyle `.label`; swap Google
   Fonts import to IBM Plex. Screenshot-diff every page manually.
4. **Hygiene.** Version badge reads from `package.json` (set `0.3.0`); extract shared
   frontend components (`Modal`, `Toast`, `EmptyState`, `ConfirmDialog`) out of page
   files; add Vitest + a first test file for `auth.js` permission helpers.
- **Acceptance:** all existing flows work (login, browse, upload, replace, move, admin
  pages, briefs); kill-list grep = 0; `npm run migrate` idempotent; new theme live.

### Phase 2 — Workspaces, members, permissions → v0.4.0
1. Migration `002_collab_core.sql`; promote Chris: `UPDATE users SET role='owner' WHERE id='usr-004'` (as a migration, with Russ's confirmation).
2. Worker: members/invitations endpoints (§3.5); extend `POST /api/workspaces` to owners;
   guard: cannot remove/downgrade the last `admin`-permission member.
3. Frontend: "New workspace" modal (name, slug auto, color picker); workspace **Members
   tab** (list, permission dropdown, remove, invite form); pending-invites list with
   revoke; Settings tab (rename, color) for wsAdmin.
4. Invitation email via existing Resend path; `member.invite` / `member.join` audit + notification events.
- **Acceptance:** Chris (owner) creates a workspace, invites a test email with `read`,
  changes it to `write`, revokes an invite; a `client` user sees no management controls;
  all mutations appear in the audit log. **Ceiling tests:** owner calling workspace
  delete (any workspace, including their own), file delete in a write-permission
  workspace, and member-remove/downgrade against the global admin all return 403 and
  write an audit_log entry.

### Phase 3 — Comments, activity, notification center → v0.5.0
1. Migration `003_comments_notifications.sql`.
2. Worker: comments CRUD, activity endpoint, inbox endpoints, `email_pref`; wire inbox
   writes into the existing notify path; `@username` mention parsing (members only).
3. Frontend: workspace **Discussion tab** (thread list + composer); file comment side
   panel in the folder browser; **Activity tab**; topnav bell with unread badge
   (60s poll), dropdown, mark-all-read; Settings gains email-preference radio.
- **Acceptance:** Russ comments on a file → Chris sees bell badge + inbox entry + email
  (pref `all`); with pref `mentions`, plain comments email nothing but `@cdepalma` does;
  deleting a comment leaves a "[deleted]" stub with replies intact.

### Phase 4 — Projects & tasks + Home redesign → v0.6.0
1. Migration `004_projects_tasks.sql`.
2. Worker: projects/tasks endpoints; task events (`task.assign`, `task.status`).
3. Frontend: workspace **Projects tab** — project list → project page with board
   (todo / in progress / done; move via button/dropdown, not drag-drop yet) and list
   toggle; task detail drawer with description, assignee, due date, comments.
4. **Home redesign** per §3.2.7: My tasks, workspace cards with last-activity, recent
   activity strip.
- **Acceptance:** Chris creates a project + tasks, assigns one to Russ; Russ sees it in
  My Tasks and gets notified; status changes appear in Activity; `read`-permission user
  can view but not edit.

### Phase 5 — Polish (pick-list, ship independently) → v1.0
- Workspace search (files, projects, tasks, comments — SQL LIKE, grouped results)
- Drag-drop upload + drag-drop task board
- File preview (images, PDF, text/markdown) in a modal
- Weekly email digest option (Worker cron trigger)
- Mobile pass on all new views
- White-label groundwork: portal name/logo/accent per workspace (the "Chris demoing to
  his own clients" story)

## 5. Testing & verification discipline

- Vitest unit tests for permission helpers and each new route module (happy path +
  one forbidden path minimum). Run in CI later; locally via `npm test` for now.
- Every phase ends with the manual smoke checklist in its PR description, executed
  against production after deploy (2 users, low risk, no staging env — acceptable).
- Rollback = redeploy previous Worker + Pages build; migrations are additive-only
  (no destructive ALTER/DROP in any phase).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Phase 0 stalls on dashboard steps (has since May) | Phases 1–5 don't depend on it; but demo-to-Chris value is zero until it ships. Treat as the top of Russ's personal queue. |
| Worker refactor regresses an endpoint | Phase 1 smoke script diffing every GET response before/after; deploy worker + frontend together. |
| D1 free-tier limits | 2 users, text rows — negligible. Storage quota logic already exists for R2. |
| Scope creep in Phase 5 | Phase 5 items are optional and individually shippable; v1.0 can ship without any of them. |
| `owner` role privilege bugs | Explicit tests: owner must NOT reach `/api/users`, `/api/audit-log`, `/api/admin/*`, other users' workspaces. |

## 7. Out of scope for v1.0

Real-time sync (WebSockets/Durable Objects), external client self-signup, per-workspace
storage billing, mobile app, GW-OS briefs visibility for non-admins (revisit later),
OAuth social login (email code is sufficient; revisit post-Phase-0).

---
*Update `handoff.yaml` and this file's Status line as phases complete.*
