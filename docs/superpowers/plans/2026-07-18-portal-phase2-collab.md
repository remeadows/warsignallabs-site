# Portal Phase 2 — Workspaces, Members, Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the `owner` role with hard security ceilings, add workspace member management and email invitations, and de-privilege `owner` across backend and frontend — shipping v0.4.0.

**Architecture:** Pure, unit-testable authorization helpers in `worker/src/auth.js` gate everything; a new `worker/src/routes/members.js` carries all member/invitation endpoints; invitations piggyback on the existing `requireAuth` email auto-map for acceptance (no Clerk API dependency). Frontend adds a Members/Settings tab system to `WorkspaceDetail.jsx` and a New-Workspace modal in the sidebar, while re-gating the admin plane from `isPrivileged` to `isAdmin`.

**Tech Stack:** Cloudflare Workers (ES modules), D1 (SQLite), Vitest, React 18 + react-router, Clerk JWT auth, Resend email.

**Spec:** `docs/superpowers/specs/2026-07-18-phase2-workspaces-members-permissions-design.md` (approved 2026-07-18). Parent: `portal-app/PORTAL_OVERHAUL_PLAN.md` §3.1/§3.2/§3.4/§3.5.

## Global Constraints

- **Ordering (non-negotiable, §3.1):** the authz rewrite (Tasks 1–3) must be implemented, reviewed, and committed BEFORE the role-promotion migration is authored or run. At deploy time (Task 9): `wrangler deploy` the narrowed Worker FIRST, run `npm run migrate` (which promotes roles) SECOND.
- **Ceilings (verbatim from §3.1, enforced server-side — UI hiding is not enforcement):**
  - Delete a workspace: global `admin` only — always. Never owners, even on workspaces they created.
  - Delete a file: global admin anywhere; owner ONLY in workspaces where they hold `admin` permission.
  - Remove a member / downgrade a permission: workspace-admin only, and NEVER against a global `admin`; cannot remove/downgrade the last `admin`-permission member of a workspace.
  - Change a user's global role, deactivate a user: global admin only.
- All commands run from `portal-app/` inside the working checkout unless stated otherwise. All `wrangler d1 execute` targets `--remote` database `wsl-portal` (id `9b47800b-5435-4e2c-890b-e38d2eea3f6a`, binding `DB`) — there is no local/staging D1.
- Every mutation endpoint writes an `audit_log` row via `logAudit(env, userId, action, details)`.
- Emails are normalized to lowercase on write (invitations and invite-created users).
- Deploy commands: Worker `cd portal-app/worker && npx wrangler deploy`; Frontend `cd portal-app && npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true`. **The frontend build requires `portal-app/.env` to exist in the checkout being built** (gitignored — a fresh worktree does NOT inherit it; copy it from the main checkout first or the deploy ships without the Clerk key and blanks production).
- Version ends at `0.4.0` (`portal-app/package.json`; topnav badge picks it up automatically).
- Branch: `feat/portal-phase2-collab` off `main`. Commit after every task.
- Test command: `npm test` (Vitest, `worker/src/**/*.test.js`, node env). Tests never require live tokens — authz logic is pure functions.

## Current-state facts the tasks rely on (verified 2026-07-18)

- `worker/src/auth.js` exports `requireAuth`, `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess`. The latter two currently bypass for `role === 'admin' || role === 'owner'` (lines ~299–312). `requireAuth`'s email auto-map branch queries `SELECT id, role, status FROM users WHERE LOWER(email) = LOWER(?)` and, on match, binds `clerk_id` and loads workspace permissions; unprovisioned users are rejected 403 (PR #26 security fix).
- `requireRole(user, 'admin', 'owner')` call sites: `users.js:11,140,165`, `workspaces.js:196,216`, `admin.js:37,87,136`. Already admin-only: `users.js:46,107`, `workspaces.js:127,165`, `files.js:421`.
- `handleCreateWorkspace` (`workspaces.js:90`) is admin-only, takes `{name, slug, color}`, defaults color to `'#00c8d4'` (stale neon — fix to `'#6F8FB8'`), creates no membership row.
- `handleUpdateWorkspace` (`workspaces.js:126`) is admin-only and accepts `name`, `color`, `storage_quota_mb`.
- `handleDeleteFile` (`files.js:420`) is `requireRole(user, 'admin')` and its file query selects `workspace_id` but not the slug.
- Router (`worker/src/router.js`) dispatches via `matchPath(pattern, pathname)` (exact segment-count match); workspace-scoped file/folder routes sit between the `/api/workspaces/:slug` GET and the `/api/users` block.
- Frontend: `PortalLayout.jsx:42-44` defines `isAdmin`/`isOwner`/`isPrivileged`; sidebar Admin section at :114 and Operations at :129 gate on `isPrivileged`; `AdminUsers.jsx` (:17,48,55), `AdminWorkspaces.jsx` (:19,48,55), `AdminAuditLog.jsx` (:32,40,63) gate on `isPrivileged`. `AdminWorkspaces.jsx:15` defines `PRESET_COLORS = ['#6F8FB8', '#4C9A6B', '#E6A51A', '#C9A557', '#9D7FB8', '#4CA3C9', '#D97757']`. The PortalAuth context exposes `d1User` (the `/api/me` payload, including `workspacePermissions`), `role`, `isAdmin`, `isOwner`, `isPrivileged`, `workspaces`.
- `src/api/client.js` exposes `useApiClient()` returning an object of `apiFetch`-backed methods; errors carry `.status` and `.data`.
- Production users: `usr-001` armeadows (admin/active), `usr-002` emergency-acct (admin/inactive), `usr-003` rmeadows (**owner**/active — promote to admin per spec), `usr-004` cdepalma (client/active — promote to owner per spec).
- `notify.js` exports `sendEmail(env, { to, subject, html, text, eventType, workspaceId, recipientUserId, metadata })` and `buildEmailHtml(title, bodyLines)`.
- `logAudit(env, userId, action, details)`; `getClientIp(request)` from `audit.js`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `worker/src/auth.js` | Modify | Narrow owner bypass; add `hasWorkspaceAdminPermission`, `memberChangeViolation`; invitation-acceptance wiring in `requireAuth` |
| `worker/src/auth.test.js` | Modify | New describe blocks for narrowed + new helpers |
| `worker/src/routes/users.js`, `admin.js` | Modify | Mechanical `admin`-only narrowing |
| `worker/src/routes/workspaces.js` | Modify | Create widens to owner + auto-membership + default color; Update widens to wsAdmin with quota guard |
| `worker/src/routes/files.js` | Modify | Delete widens from admin-only to admin-or-wsAdmin |
| `worker/src/routes/members.js` | Create | Members list/patch/remove + invitations create/list/revoke |
| `worker/src/router.js` | Modify | Routes for members + invitations |
| `worker/migrations/002_collab_core.sql` | Create | `invitations` table |
| `worker/migrations/003_role_promotions.sql` | Create | usr-004→owner, usr-003→admin |
| `src/api/client.js` | Modify | Member/invitation/workspace-create/update methods |
| `src/constants/palette.js` | Create | Shared `PRESET_COLORS` |
| `src/components/NewWorkspaceModal.jsx` | Create | Create-workspace modal (sidebar) |
| `src/components/workspace/MembersTab.jsx` | Create | Member list, permission dropdown, remove, invite form, pending invites |
| `src/components/workspace/WorkspaceSettingsTab.jsx` | Create | Rename + color for wsAdmin |
| `src/pages/WorkspaceDetail.jsx` | Modify | Tab bar (Files · Members · Settings) |
| `src/layouts/PortalLayout.jsx` | Modify | `isPrivileged`→`isAdmin` re-gating; New-workspace button + modal |
| `src/pages/AdminUsers.jsx`, `AdminWorkspaces.jsx`, `AdminAuditLog.jsx` | Modify | `isPrivileged`→`isAdmin`; palette import |
| `package.json` | Modify | 0.3.0 → 0.4.0 |

---

### Task 1: Authz core — narrow the owner bypass, add ceiling helpers, tests

**Files:**
- Modify: `worker/src/auth.js` (the three helpers at the bottom of the file, ~lines 291–313)
- Test: `worker/src/auth.test.js`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `hasWorkspaceAdminPermission(user, workspaceSlug) → boolean` — true iff `user.role === 'admin'` OR `user.workspacePermissions[workspaceSlug] === 'admin'`.
  - `memberChangeViolation(targetRole, remainingAdminCount) → string | null` — non-null message = blocked.
  - `requireWorkspaceAccess` / `hasWorkspaceWriteAccess` — same signatures as today, but ONLY `role === 'admin'` bypasses; `owner` falls through to per-workspace checks like `client`.

- [ ] **Step 1: Write the failing tests.** Append to `worker/src/auth.test.js` (and extend its import line to `import { requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission, memberChangeViolation } from './auth.js'`):

```javascript
describe('owner is NOT a global bypass (Phase 2 §3.1)', () => {
  it('requireWorkspaceAccess throws 403 for an owner with no membership', () => {
    const user = makeUser({ role: 'owner', workspaceSlugs: ['their-own'] })
    let thrown
    try { requireWorkspaceAccess(user, 'russ-workspace') } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
  })

  it('requireWorkspaceAccess allows an owner whose workspaceSlugs includes the target', () => {
    const user = makeUser({ role: 'owner', workspaceSlugs: ['their-own'] })
    expect(() => requireWorkspaceAccess(user, 'their-own')).not.toThrow()
  })

  it('hasWorkspaceWriteAccess is false for an owner with no permission entry', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'russ-workspace')).toBe(false)
  })

  it('hasWorkspaceWriteAccess is true for an owner with write permission', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'write' } })
    expect(hasWorkspaceWriteAccess(user, 'their-own')).toBe(true)
  })

  it('admin still bypasses both', () => {
    const user = makeUser({ role: 'admin', workspaceSlugs: [], workspacePermissions: {} })
    expect(() => requireWorkspaceAccess(user, 'anything')).not.toThrow()
    expect(hasWorkspaceWriteAccess(user, 'anything')).toBe(true)
  })
})

describe('hasWorkspaceAdminPermission', () => {
  it('true for global admin regardless of permissions', () => {
    expect(hasWorkspaceAdminPermission(makeUser({ role: 'admin' }), 'any')).toBe(true)
  })
  it('true for owner with admin permission on the workspace', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'admin' } })
    expect(hasWorkspaceAdminPermission(user, 'their-own')).toBe(true)
  })
  it('false for owner with only write permission', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'write' } })
    expect(hasWorkspaceAdminPermission(user, 'their-own')).toBe(false)
  })
  it('false for owner with no entry', () => {
    expect(hasWorkspaceAdminPermission(makeUser({ role: 'owner' }), 'other')).toBe(false)
  })
  it('true for client with admin permission (permission tier, not global role, decides)', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { ws: 'admin' } })
    expect(hasWorkspaceAdminPermission(user, 'ws')).toBe(true)
  })
})

describe('memberChangeViolation (remove/downgrade ceilings)', () => {
  it('blocks any change targeting a global admin', () => {
    expect(memberChangeViolation('admin', 5)).toMatch(/global admin/i)
  })
  it('blocks a change that would leave zero admin-permission members', () => {
    expect(memberChangeViolation('client', 0)).toMatch(/at least one/i)
  })
  it('allows a normal change', () => {
    expect(memberChangeViolation('client', 1)).toBeNull()
    expect(memberChangeViolation('owner', 2)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure.** `npm test` → expect FAIL: `hasWorkspaceAdminPermission is not a function` (and the two owner-bypass tests fail against current code).

- [ ] **Step 3: Implement.** In `worker/src/auth.js`, replace the current `requireWorkspaceAccess` and `hasWorkspaceWriteAccess` bodies and append the two new exports:

```javascript
export function requireWorkspaceAccess(user, workspaceSlug) {
  if (user.role === 'admin') {
    return
  }
  if (!user.workspaceSlugs.includes(workspaceSlug)) {
    throw errorResponse('Forbidden: you do not have access to this workspace', 403)
  }
}

export function hasWorkspaceWriteAccess(user, workspaceSlug) {
  if (user.role === 'admin') return true
  const perm = (user.workspacePermissions || {})[workspaceSlug]
  return perm === 'write' || perm === 'admin'
}

// wsAdmin (§3.5): global admin, or admin permission on this specific workspace.
export function hasWorkspaceAdminPermission(user, workspaceSlug) {
  if (user.role === 'admin') return true
  return (user.workspacePermissions || {})[workspaceSlug] === 'admin'
}

// Ceiling check for member remove/downgrade (§3.1). remainingAdminCount is the
// count of admin-permission members the workspace would have AFTER the action.
// Returns a human-readable violation, or null if the change is allowed.
export function memberChangeViolation(targetRole, remainingAdminCount) {
  if (targetRole === 'admin') {
    return 'Cannot remove or downgrade a global admin'
  }
  if (remainingAdminCount < 1) {
    return 'Workspace must retain at least one admin-permission member'
  }
  return null
}
```

- [ ] **Step 4: Run tests.** `npm test` → all pass (9 existing + 13 new = 22).
- [ ] **Step 5: Lint + commit.** `npx eslint worker/src/auth.js worker/src/auth.test.js` (clean), then:

```bash
git add worker/src/auth.js worker/src/auth.test.js
git commit -m "feat(portal): narrow owner to per-workspace authz, add wsAdmin + member-change ceiling helpers"
```

---

### Task 2: Mechanical narrowing — users.js and admin.js go admin-only

**Files:**
- Modify: `worker/src/routes/users.js:11,140,165`
- Modify: `worker/src/routes/admin.js:37,87,136`

**Interfaces:** Consumes `requireRole` (unchanged). No signature changes.

- [ ] **Step 1:** In `users.js`, change lines 11, 140, 165 from `requireRole(user, 'admin', 'owner')` to `requireRole(user, 'admin')` (handlers: `handleListUsers`, `handleDeactivateUser`, `handleActivateUser`). Do NOT touch lines 46/107 (already admin-only).
- [ ] **Step 2:** In `admin.js`, change lines 37, 87, 136 the same way (`handleAuditLog`, `handleAdminAnalytics`, `handleDashboardProjects`).
- [ ] **Step 3:** Also in `workspaces.js`, change lines 196 and 216 (`handleGetUserWorkspaces`, `handleUpdateUserWorkspaces`) to `requireRole(user, 'admin')`.
- [ ] **Step 4: Verify.** `grep -rn "requireRole(user, 'admin', 'owner')" worker/src/` → zero hits (`handleCreateWorkspace` is still admin-only at this point; Task 3 widens it back to admin+owner). `npm test` still passes; `npx eslint worker/src/routes/users.js worker/src/routes/admin.js worker/src/routes/workspaces.js` clean.
- [ ] **Step 5: Commit.**

```bash
git add worker/src/routes/users.js worker/src/routes/admin.js worker/src/routes/workspaces.js
git commit -m "fix(portal): admin plane goes admin-only — owner loses users/audit/analytics/ops access"
```

---

### Task 3: Workspace create/update + file delete — the widenings

**Files:**
- Modify: `worker/src/routes/workspaces.js` (`handleCreateWorkspace`, `handleUpdateWorkspace`)
- Modify: `worker/src/routes/files.js` (`handleDeleteFile`, lines 420–433)

**Interfaces:**
- Consumes from Task 1: `hasWorkspaceAdminPermission(user, slug)`.
- `workspaces.js` must extend its auth import to: `import { requireRole, requireWorkspaceAccess, hasWorkspaceAdminPermission } from '../auth.js'`. `files.js` adds `hasWorkspaceAdminPermission` to its existing auth import.

- [ ] **Step 1: `handleCreateWorkspace`** — replace the auth line, default color, and add creator auto-membership. Full replacement body (keep the existing JSDoc, update its text to "admin or owner"):

```javascript
export async function handleCreateWorkspace(request, env, user) {
  requireRole(user, 'admin', 'owner')

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { name, slug, color } = body
  if (!name || !slug) return errorResponse('name and slug are required', 400)

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse('slug must be lowercase alphanumeric with hyphens only', 400)
  }

  const existing = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?')
    .bind(slug).first()
  if (existing) return errorResponse('A workspace with this slug already exists', 409)

  const wsColor = color || '#6F8FB8'
  const wsId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, slug, color, storage_quota_mb, storage_used_mb, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2048, 0, datetime('now'), datetime('now'))`,
  ).bind(wsId, name, slug, wsColor).run()

  // Creator becomes an admin-permission member (§3.2.1). Global admins get the
  // row too — harmless, and it keeps the "last admin-permission member" guard
  // meaningful from day one.
  await env.DB.prepare(
    `INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
     VALUES (?, ?, ?, 'admin', datetime('now'))`,
  ).bind(crypto.randomUUID(), user.dbUserId, wsId).run()

  await logAudit(env, user.userId, 'workspace.create', {
    resourceType: 'workspace', resourceId: wsId,
    name, slug, ipAddress: getClientIp(request),
  })

  return jsonResponse({ workspace: { id: wsId, name, slug, color: wsColor } }, 201)
}
```

- [ ] **Step 2: `handleUpdateWorkspace`** — widen to wsAdmin, keep quota admin-only. Replace the first two statements of the handler (`requireRole(user, 'admin')` and keep the workspace lookup) with:

```javascript
export async function handleUpdateWorkspace(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }

  const workspace = await env.DB.prepare('SELECT id, name, slug, color FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  // Storage quota is infrastructure, not workspace settings (§3.1 grants
  // wsAdmin "rename workspace, workspace settings" only).
  if (body.storage_quota_mb && user.role !== 'admin') {
    return errorResponse('Forbidden: only a global admin can change storage quota', 403)
  }
```

  (Rest of the handler — the `updates`/`bindings` loop, audit, response — is unchanged.)

- [ ] **Step 3: `handleDeleteFile`** — widen from admin-only to admin-or-wsAdmin. Replace the opening of the handler (the `requireRole` line and the file query) with:

```javascript
export async function handleDeleteFile(request, env, user, params, ctx) {
  const fileId = params.id

  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.workspace_id, w.slug AS workspace_slug
     FROM files f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  )
    .bind(fileId)
    .first()

  if (!file) {
    return errorResponse('File not found', 404)
  }

  // Ceiling (§3.1): global admin anywhere; otherwise admin permission on THIS
  // workspace. write/read members — including owners — cannot delete files.
  if (!hasWorkspaceAdminPermission(user, file.workspace_slug)) {
    await logAudit(env, user.userId, 'file.delete.denied', {
      resourceType: 'file', resourceId: fileId,
      workspaceSlug: file.workspace_slug, ipAddress: getClientIp(request),
    })
    throw errorResponse('Forbidden: workspace admin permission required to delete files', 403)
  }
```

  (Rest of the handler — R2 delete, D1 delete, audit, notify — unchanged. **Ceiling denial writes an audit row**, per §3.1 acceptance: "403 + audit_log entry".)

- [ ] **Step 4: Guard check that must NOT change:** confirm `handleDeleteWorkspace` still reads `requireRole(user, 'admin')` — `grep -n "requireRole" worker/src/routes/workspaces.js` must show line ~165 admin-only. This is Russ's core constraint; do not touch it.
- [ ] **Step 5: Verify.** `npm test` passes; `npx eslint worker/src/routes/workspaces.js worker/src/routes/files.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 6: Commit.**

```bash
git add worker/src/routes/workspaces.js worker/src/routes/files.js
git commit -m "feat(portal): workspace create opens to owner w/ auto-membership; update + file delete gate on wsAdmin"
```

---

### Task 4: Migrations — invitations table + role promotions

**Files:**
- Create: `worker/migrations/002_collab_core.sql`
- Create: `worker/migrations/003_role_promotions.sql`

**Interfaces:** Produces the `invitations` table Task 5/6 handlers query. Migrations are NOT run in this task — execution happens in Task 9, after the narrowed Worker deploys.

- [ ] **Step 1:** Create `worker/migrations/002_collab_core.sql`:

```sql
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
```

- [ ] **Step 2:** Create `worker/migrations/003_role_promotions.sql`:

```sql
-- 003_role_promotions.sql — Phase 2 role changes (spec §2, Russ-approved 2026-07-18).
-- MUST only run after the narrowed authz Worker (Tasks 1-3) is deployed.
UPDATE users SET role = 'owner', updated_at = datetime('now') WHERE id = 'usr-004';  -- Chris: client -> owner
UPDATE users SET role = 'admin', updated_at = datetime('now') WHERE id = 'usr-003';  -- rmeadows: owner -> admin
```

- [ ] **Step 3: Validate locally** (scratch SQLite only — do NOT run against remote D1 yet):

```bash
sqlite3 /tmp/phase2-mig-check.db < worker/migrations/000_baseline.sql
sqlite3 /tmp/phase2-mig-check.db < worker/migrations/002_collab_core.sql
sqlite3 /tmp/phase2-mig-check.db < worker/migrations/002_collab_core.sql   # idempotency
sqlite3 /tmp/phase2-mig-check.db ".tables" && rm /tmp/phase2-mig-check.db
```

Expected: no errors, second run clean, `invitations` in the table list. (003 is intentionally not idempotency-tested — the migrate runner records it once; the UPDATEs are also naturally re-runnable.)

- [ ] **Step 4: Commit.**

```bash
git add worker/migrations/002_collab_core.sql worker/migrations/003_role_promotions.sql
git commit -m "feat(portal): invitations schema + role-promotion migrations (not yet applied)"
```

---

### Task 5: Members endpoints — list, change permission, remove

**Files:**
- Create: `worker/src/routes/members.js`
- Modify: `worker/src/router.js`

**Interfaces:**
- Consumes: `requireWorkspaceAccess`, `hasWorkspaceAdminPermission`, `memberChangeViolation` (Task 1); `jsonResponse`/`errorResponse`; `logAudit`/`getClientIp`.
- Produces for Task 6 (same file): the `getWorkspaceBySlug` helper. Produces for Task 8 (frontend): `GET .../members` → `{ members: [{ id, username, email, role, permission }] }`.

- [ ] **Step 1:** Create `worker/src/routes/members.js`:

```javascript
// worker/src/routes/members.js
// Workspace membership + invitations (Phase 2). All ceilings enforced here
// server-side via the pure helpers in ../auth.js — UI hiding is not enforcement.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceAdminPermission, memberChangeViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'

export async function getWorkspaceBySlug(env, slug) {
  return env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE slug = ?')
    .bind(slug).first()
}

async function adminPermissionCount(env, workspaceId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_workspaces WHERE workspace_id = ? AND permission = 'admin'`,
  ).bind(workspaceId).first()
  return row?.cnt || 0
}

/** GET /api/workspaces/:slug/members — any member */
export async function handleListMembers(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE uw.workspace_id = ? ORDER BY u.username`,
  ).bind(workspace.id).all()

  return jsonResponse({ members: result.results })
}

/** PATCH /api/workspaces/:slug/members/:userId — wsAdmin. Body: {permission} */
export async function handleUpdateMemberPermission(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const { permission } = body
  if (!['read', 'write', 'admin'].includes(permission)) {
    return errorResponse("permission must be one of: read, write, admin", 400)
  }

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)
  if (target.permission === permission) {
    return jsonResponse({ message: 'No change', permission })
  }

  // Ceiling: never a global admin; never zero out the last admin-permission member.
  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' && permission !== 'admin'
    ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.permission_change.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, attempted: permission, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('UPDATE user_workspaces SET permission = ? WHERE id = ?')
    .bind(permission, target.uw_id).run()

  await logAudit(env, user.userId, 'member.permission_change', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, from: target.permission, to: permission,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Permission updated', permission })
}

/** DELETE /api/workspaces/:slug/members/:userId — wsAdmin */
export async function handleRemoveMember(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)

  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.remove.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('DELETE FROM user_workspaces WHERE id = ?').bind(target.uw_id).run()

  await logAudit(env, user.userId, 'member.remove', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, username: target.username,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Member removed' })
}
```

- [ ] **Step 2: Wire the router.** In `worker/src/router.js`, add to the imports:

```javascript
import {
  handleListMembers,
  handleUpdateMemberPermission,
  handleRemoveMember,
} from './routes/members.js'
```

and insert this block immediately after the `/api/folders/:id/move` block (before the `/api/users` block):

```javascript
        params = matchPath('/api/workspaces/:slug/members', pathname)
        if (params && method === 'GET') {
          return handleListMembers(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/members/:userId', pathname)
        if (params && method === 'PATCH') {
          return handleUpdateMemberPermission(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return handleRemoveMember(request, env, user, params)
        }
```

- [ ] **Step 3: Verify.** `npm test` passes; `npx eslint worker/src/routes/members.js worker/src/router.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/members.js worker/src/router.js
git commit -m "feat(portal): members endpoints — list, permission change, remove, with ceiling guards + denial audits"
```

---

### Task 6: Invitations — create/list/revoke, acceptance wiring, email

**Files:**
- Modify: `worker/src/routes/members.js` (append invitation handlers)
- Modify: `worker/src/router.js` (invitation routes)
- Modify: `worker/src/auth.js` (acceptance wiring in `requireAuth`'s email-map branch)

**Interfaces:**
- Consumes: `getWorkspaceBySlug` (Task 5), `sendEmail`/`buildEmailHtml` from `../notify.js`, `invitations` table (Task 4).
- Produces for Task 8: `GET .../invitations` → `{ invitations: [{ id, email, permission, status, created_at }] }`; `POST .../invitations` body `{email, permission}` → 201; `DELETE /api/invitations/:id` → 200.

- [ ] **Step 1: Append to `worker/src/routes/members.js`** (add `import { sendEmail, buildEmailHtml } from '../notify.js'` at the top):

```javascript
/** POST /api/workspaces/:slug/invitations — wsAdmin. Body: {email, permission} */
export async function handleCreateInvitation(request, env, user, params, ctx) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const email = (body.email || '').trim().toLowerCase()
  const { permission } = body
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse('A valid email is required', 400)
  }
  if (!['read', 'write', 'admin'].includes(permission)) {
    return errorResponse("permission must be one of: read, write, admin", 400)
  }

  // Edge rules (spec §4): already a member -> 409; already pending -> 409.
  let invitee = await env.DB.prepare('SELECT id, username, status FROM users WHERE LOWER(email) = ?')
    .bind(email).first()
  if (invitee) {
    const existingMembership = await env.DB.prepare(
      'SELECT id FROM user_workspaces WHERE user_id = ? AND workspace_id = ?',
    ).bind(invitee.id, workspace.id).first()
    if (existingMembership) {
      return errorResponse('Already a member — change their permission from the members list instead', 409)
    }
  }
  const pendingInvite = await env.DB.prepare(
    `SELECT id FROM invitations WHERE email = ? AND workspace_id = ? AND status = 'pending'`,
  ).bind(email, workspace.id).first()
  if (pendingInvite) {
    return errorResponse('Invitation already pending — revoke it first to re-send', 409)
  }

  // Create the user row if none exists (status='invited'; activated by
  // requireAuth's email auto-map on first sign-in — no Clerk API dependency).
  if (!invitee) {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'invited'
    let username = base
    for (let n = 2; ; n++) {
      const clash = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
      if (!clash) break
      username = `${base}-${n}`
    }
    const newUserId = `usr-${crypto.randomUUID().slice(0, 8)}`
    await env.DB.prepare(
      `INSERT INTO users (id, username, email, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'client', 'invited', datetime('now'), datetime('now'))`,
    ).bind(newUserId, username, email).run()
    invitee = { id: newUserId, username, status: 'invited' }
  }

  // Membership row now; it goes live the moment their sign-in maps.
  await env.DB.prepare(
    `INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).bind(crypto.randomUUID(), invitee.id, workspace.id, permission).run()

  const invId = `inv-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO invitations (id, workspace_id, email, permission, invited_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).bind(invId, workspace.id, email, permission, user.dbUserId).run()

  await logAudit(env, user.userId, 'member.invite', {
    resourceType: 'invitation', resourceId: invId,
    workspaceSlug: params.slug, email, permission,
    ipAddress: getClientIp(request),
  })

  const html = buildEmailHtml(`You've been invited to ${workspace.name}`, [
    `<strong>Workspace:</strong> ${workspace.name}`,
    `<strong>Access level:</strong> ${permission}`,
    `<strong>Invited by:</strong> ${user.email || 'the workspace admin'}`,
    `Sign in with this email address at <a href="https://portal.warsignallabs.net">portal.warsignallabs.net</a> — your access is ready.`,
  ])
  ctx.waitUntil(sendEmail(env, {
    to: email,
    subject: `WarSignalLabs Portal — invitation to ${workspace.name}`,
    html,
    text: `You've been invited to ${workspace.name} (${permission}). Sign in with this email at https://portal.warsignallabs.net`,
    eventType: 'member.invite',
    workspaceId: workspace.id,
    recipientUserId: invitee.id,
    metadata: { invitationId: invId, permission },
  }))

  return jsonResponse({ invitation: { id: invId, email, permission, status: 'pending' } }, 201)
}

/** GET /api/workspaces/:slug/invitations — wsAdmin */
export async function handleListInvitations(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const result = await env.DB.prepare(
    `SELECT id, email, permission, status, created_at FROM invitations
     WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC`,
  ).bind(workspace.id).all()

  return jsonResponse({ invitations: result.results })
}

/** DELETE /api/invitations/:id — wsAdmin on the invitation's workspace. Revoke + undo. */
export async function handleRevokeInvitation(request, env, user, params) {
  const invitation = await env.DB.prepare(
    `SELECT i.id, i.email, i.status, i.workspace_id, w.slug AS workspace_slug
     FROM invitations i INNER JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.id = ?`,
  ).bind(params.id).first()
  if (!invitation) return errorResponse('Invitation not found', 404)

  if (!hasWorkspaceAdminPermission(user, invitation.workspace_slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  if (invitation.status !== 'pending') {
    return errorResponse(`Cannot revoke an invitation that is ${invitation.status}`, 409)
  }

  await env.DB.prepare(`UPDATE invitations SET status = 'revoked' WHERE id = ?`)
    .bind(invitation.id).run()

  // Undo the pre-created membership. Safe: inviting an existing member is
  // 409-blocked, so a membership row matching a pending invite can only have
  // come from that invite.
  const invitee = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
    .bind(invitation.email).first()
  if (invitee) {
    await env.DB.prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace_id = ?')
      .bind(invitee.id, invitation.workspace_id).run()
  }

  await logAudit(env, user.userId, 'invitation.revoke', {
    resourceType: 'invitation', resourceId: invitation.id,
    workspaceSlug: invitation.workspace_slug, email: invitation.email,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Invitation revoked' })
}
```

- [ ] **Step 2: Router.** Extend the members import with the three new handlers and add after the members block:

```javascript
        params = matchPath('/api/workspaces/:slug/invitations', pathname)
        if (params && method === 'GET') {
          return handleListInvitations(request, env, user, params)
        }
        if (params && method === 'POST') {
          return handleCreateInvitation(request, env, user, params, ctx)
        }

        params = matchPath('/api/invitations/:id', pathname)
        if (params && method === 'DELETE') {
          return handleRevokeInvitation(request, env, user, params)
        }
```

- [ ] **Step 3: Acceptance wiring in `requireAuth`.** In `worker/src/auth.js`, inside the email-map branch, directly after the existing
`await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?').bind(clerkUserId, matched.id).run()` and its `console.log`, insert:

```javascript
        // Invitation acceptance (Phase 2 spec §3): first sign-in of an invited
        // user activates the account and closes out their pending invitations.
        if (matched.status === 'invited') {
          await env.DB.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`)
            .bind(matched.id).run()
        }
        const accepted = await env.DB.prepare(
          `UPDATE invitations SET status = 'accepted', accepted_at = datetime('now')
           WHERE LOWER(email) = LOWER(?) AND status = 'pending'`,
        ).bind(email).run()
        if (accepted?.meta?.changes > 0) {
          await logAudit(env, matched.id, 'member.join', {
            resourceType: 'user', resourceId: matched.id,
            invitationsAccepted: accepted.meta.changes,
          })
        }
```

  `auth.js` must import `logAudit`: add `import { logAudit } from './audit.js'` at the top (verify no circular import — `audit.js` does not import from `auth.js`).

- [ ] **Step 4: Verify.** `npm test` passes; `npx eslint worker/src/routes/members.js worker/src/router.js worker/src/auth.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 5: Commit.**

```bash
git add worker/src/routes/members.js worker/src/router.js worker/src/auth.js
git commit -m "feat(portal): invitations — create/list/revoke, requireAuth acceptance wiring, Resend email"
```

---

### Task 7: Frontend plumbing — API client, palette constant, admin re-gating, New-workspace modal

**Files:**
- Modify: `src/api/client.js`
- Create: `src/constants/palette.js`
- Create: `src/components/NewWorkspaceModal.jsx`
- Modify: `src/layouts/PortalLayout.jsx`
- Modify: `src/pages/AdminUsers.jsx`, `src/pages/AdminWorkspaces.jsx`, `src/pages/AdminAuditLog.jsx`

**Interfaces:**
- Produces for Task 8: api methods `listMembers(slug)`, `updateMemberPermission(slug, userId, permission)`, `removeMember(slug, userId)`, `listInvitations(slug)`, `createInvitation(slug, email, permission)`, `revokeInvitation(id)`, `createWorkspace({name, slug, color})`, `updateWorkspace(slug, data)`; `PRESET_COLORS` from `src/constants/palette.js`.

- [ ] **Step 1: API client.** In `src/api/client.js`, inside the `useMemo` object (after the Workspaces group), add:

```javascript
    createWorkspace: (data) => apiFetch('/api/workspaces', getToken, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    updateWorkspace: (slug, data) => apiFetch(`/api/workspaces/${slug}`, getToken, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

    // Members & invitations (Phase 2)
    listMembers: (slug) => apiFetch(`/api/workspaces/${slug}/members`, getToken),
    updateMemberPermission: (slug, userId, permission) =>
      apiFetch(`/api/workspaces/${slug}/members/${userId}`, getToken, {
        method: 'PATCH',
        body: JSON.stringify({ permission }),
      }),
    removeMember: (slug, userId) =>
      apiFetch(`/api/workspaces/${slug}/members/${userId}`, getToken, { method: 'DELETE' }),
    listInvitations: (slug) => apiFetch(`/api/workspaces/${slug}/invitations`, getToken),
    createInvitation: (slug, email, permission) =>
      apiFetch(`/api/workspaces/${slug}/invitations`, getToken, {
        method: 'POST',
        body: JSON.stringify({ email, permission }),
      }),
    revokeInvitation: (id) => apiFetch(`/api/invitations/${id}`, getToken, { method: 'DELETE' }),
```

- [ ] **Step 2: Palette constant.** Create `src/constants/palette.js`:

```javascript
// Shared workspace color palette (executive theme, Phase 1 Task 9).
export const PRESET_COLORS = ['#6F8FB8', '#4C9A6B', '#E6A51A', '#C9A557', '#9D7FB8', '#4CA3C9', '#D97757']
```

In `src/pages/AdminWorkspaces.jsx`, delete the local `const PRESET_COLORS = [...]` (line 15) and add `import { PRESET_COLORS } from '../constants/palette'`.

- [ ] **Step 3: Re-gate the admin plane.** (Spec §5 — otherwise owners see admin links that all 403.)
  - `src/layouts/PortalLayout.jsx`: change BOTH `{isPrivileged && (` guards (Admin section :114, Operations section :129) to `{isAdmin && (`.
  - `src/pages/AdminUsers.jsx`: lines 48/49/55 — replace `isPrivileged` with `isAdmin` (keep the destructured `isAdmin` already imported; remove `isPrivileged` from the destructure).
  - `src/pages/AdminWorkspaces.jsx`: destructure `isAdmin` instead of `isPrivileged`; replace at lines 48/49/55.
  - `src/pages/AdminAuditLog.jsx`: destructure `isAdmin` instead of `isPrivileged`; replace at lines 40/53/63.
  - Verify no other owner-reachable `isPrivileged` remains except the New-workspace button (Step 5): `grep -rn "isPrivileged" src/` — expected hits ONLY in `PortalLayout.jsx` (context definition + New-workspace button) and `PortalAuth.jsx` (context default).

- [ ] **Step 4: New-workspace modal.** Create `src/components/NewWorkspaceModal.jsx`:

```javascript
import { useState } from 'react'
import { useApiClient } from '../api/client'
import { PRESET_COLORS } from '../constants/palette'

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default function NewWorkspaceModal({ onClose, onCreated }) {
  const api = useApiClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError(null)
    const base = slugify(name)
    // Auto-slug with numeric suffix on collision (spec §5).
    for (let n = 1; n <= 10; n++) {
      const slug = n === 1 ? base : `${base}-${n}`
      try {
        const result = await api.createWorkspace({ name: name.trim(), slug, color })
        onCreated(result.workspace)
        return
      } catch (err) {
        if (err.status === 409) continue
        setError(err.status === 403 ? 'Permission denied.' : (err.data?.error || 'Could not create workspace.'))
        setSaving(false)
        return
      }
    }
    setError('Could not find an available name — try a different one.')
    setSaving(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h2>New Workspace</h2>
        {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
        <label className="label">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workspace name"
          autoFocus
        />
        {name.trim() && <div className="modal__hint mono">/{slugify(name)}</div>}
        <label className="label">Color</label>
        <div className="modal__swatches">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              className={`color-swatch ${color === c ? 'color-swatch--active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="modal__actions">
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn--primary" onClick={handleCreate} disabled={saving}>
            {saving ? 'Creating…' : 'Create Workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

  (Match the existing modal class names used by `AdminWorkspaces.jsx`'s inline modal — check its JSX during implementation and reuse the same `modal-overlay`/`modal`/`color-swatch` classes so no new CSS is needed; if its class names differ from the above, follow the codebase, not this snippet.)

- [ ] **Step 5: Sidebar button.** In `PortalLayout.jsx`: add state `const [showNewWorkspace, setShowNewWorkspace] = useState(false)`, import the modal and `useNavigate`. In the Workspaces sidebar section, after the workspace NavLinks, add:

```javascript
              {isPrivileged && (
                <button className="sidebar__link sidebar__link--action" onClick={() => setShowNewWorkspace(true)}>
                  + New Workspace
                </button>
              )}
```

and render before the closing of the layout:

```javascript
      {showNewWorkspace && (
        <NewWorkspaceModal
          onClose={() => setShowNewWorkspace(false)}
          onCreated={(ws) => {
            setShowNewWorkspace(false)
            refreshWorkspaces()          // the existing function/effect that loads the sidebar list — re-trigger it
            navigate(`/workspace/${ws.slug}`)
          }}
        />
      )}
```

  (During implementation, locate how `workspaces` state is populated in `PortalLayout.jsx` and re-invoke that fetch; if it's a bare `useEffect`, extract its body into a `refreshWorkspaces` callback used by both.) Add a minimal `.sidebar__link--action` style in `PortalLayout.css` (muted color, same padding as `.sidebar__link`).

- [ ] **Step 6: Verify.** `npm run build` clean; `npx eslint src/` clean; `npm test` unaffected.
- [ ] **Step 7: Commit.**

```bash
git add src/api/client.js src/constants/palette.js src/components/NewWorkspaceModal.jsx src/layouts/PortalLayout.jsx src/layouts/PortalLayout.css src/pages/AdminUsers.jsx src/pages/AdminWorkspaces.jsx src/pages/AdminAuditLog.jsx
git commit -m "feat(portal): admin plane admin-only in UI, shared palette, sidebar New Workspace modal, member/invite API client"
```

---

### Task 8: Workspace tabs — Members + Settings

**Files:**
- Create: `src/components/workspace/MembersTab.jsx`
- Create: `src/components/workspace/WorkspaceSettingsTab.jsx`
- Modify: `src/pages/WorkspaceDetail.jsx` (tab bar between header and breadcrumbs)
- Modify: `src/pages/WorkspaceDetail.css` (tab styles)

**Interfaces:**
- Consumes: Task 7 api methods; `usePortalAuth()` → `{ d1User, isAdmin }` where `d1User.workspacePermissions` maps slug → permission.
- wsAdmin in the UI = `isAdmin || d1User?.workspacePermissions?.[slug] === 'admin'`.

- [ ] **Step 1: MembersTab.** Create `src/components/workspace/MembersTab.jsx`:

```javascript
import { useState, useEffect, useCallback } from 'react'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'

const PERMISSIONS = ['read', 'write', 'admin']

export default function MembersTab({ slug }) {
  const api = useApiClient()
  const { d1User, isAdmin } = usePortalAuth()
  const wsAdmin = isAdmin || d1User?.workspacePermissions?.[slug] === 'admin'

  const [members, setMembers] = useState([])
  const [invitations, setInvitations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePermission, setInvitePermission] = useState('read')
  const [inviting, setInviting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const m = await api.listMembers(slug)
      setMembers(m.members)
      if (wsAdmin) {
        const inv = await api.listInvitations(slug)
        setInvitations(inv.invitations)
      }
      setError(null)
    } catch (err) {
      setError(err.data?.error || 'Could not load members.')
    } finally {
      setLoading(false)
    }
  }, [api, slug, wsAdmin])

  useEffect(() => { load() }, [load])

  const changePermission = async (userId, permission) => {
    try {
      await api.updateMemberPermission(slug, userId, permission)
      load()
    } catch (err) {
      setError(err.data?.error || 'Permission change failed.')
    }
  }

  const removeMember = async (member) => {
    if (!confirm(`Remove ${member.username} from this workspace?`)) return
    try {
      await api.removeMember(slug, member.id)
      load()
    } catch (err) {
      setError(err.data?.error || 'Remove failed.')
    }
  }

  const invite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    try {
      await api.createInvitation(slug, inviteEmail.trim(), invitePermission)
      setInviteEmail('')
      setInvitePermission('read')
      setError(null)
      load()
    } catch (err) {
      setError(err.data?.error || 'Invite failed.')
    } finally {
      setInviting(false)
    }
  }

  const revoke = async (inv) => {
    try {
      await api.revokeInvitation(inv.id)
      load()
    } catch (err) {
      setError(err.data?.error || 'Revoke failed.')
    }
  }

  if (loading) return <div className="workspace__loading">Loading members…</div>

  return (
    <div className="members-tab">
      {error && (
        <div className="workspace__alert workspace__alert--error">
          {error}
          <button className="workspace__alert-dismiss" onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      <table className="members-table">
        <thead>
          <tr><th>Member</th><th>Email</th><th>Permission</th>{wsAdmin && <th></th>}</tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr key={m.id}>
              <td>
                {m.username}
                {m.role === 'admin' && <span className="members-chip members-chip--admin">Admin</span>}
                {m.role === 'owner' && <span className="members-chip">Collaborator</span>}
                {m.status === 'invited' && <span className="members-chip members-chip--pending">Invited</span>}
              </td>
              <td className="mono">{m.email}</td>
              <td>
                {wsAdmin && m.role !== 'admin' ? (
                  <select value={m.permission} onChange={(e) => changePermission(m.id, e.target.value)}>
                    {PERMISSIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <span>{m.permission}</span>
                )}
              </td>
              {wsAdmin && (
                <td>
                  {m.role !== 'admin' && (
                    <button className="btn btn--danger-outline" onClick={() => removeMember(m)}>Remove</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {wsAdmin && (
        <>
          <h3 className="label">Invite by email</h3>
          <div className="members-invite">
            <input
              type="email"
              placeholder="name@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <select value={invitePermission} onChange={(e) => setInvitePermission(e.target.value)}>
              {PERMISSIONS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button className="btn btn--primary" onClick={invite} disabled={inviting}>
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </div>

          {invitations.length > 0 && (
            <>
              <h3 className="label">Pending invitations</h3>
              <table className="members-table">
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td className="mono">{inv.email}</td>
                      <td>{inv.permission}</td>
                      <td><button className="btn btn--danger-outline" onClick={() => revoke(inv)}>Revoke</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: SettingsTab.** Create `src/components/workspace/WorkspaceSettingsTab.jsx`:

```javascript
import { useState } from 'react'
import { useApiClient } from '../../api/client'
import { PRESET_COLORS } from '../../constants/palette'

export default function WorkspaceSettingsTab({ slug, workspace, onSaved }) {
  const api = useApiClient()
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateWorkspace(slug, { name, color })
      setMessage({ kind: 'ok', text: 'Saved.' })
      onSaved()
    } catch (err) {
      setMessage({ kind: 'err', text: err.data?.error || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-tab">
      {message && (
        <div className={`workspace__alert ${message.kind === 'err' ? 'workspace__alert--error' : ''}`}>
          {message.text}
        </div>
      )}
      <label className="label">Workspace name</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="label">Color</label>
      <div className="modal__swatches">
        {PRESET_COLORS.map(c => (
          <button
            key={c}
            className={`color-swatch ${color === c ? 'color-swatch--active' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <button className="btn btn--primary" onClick={save} disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Tabs in `WorkspaceDetail.jsx`.** Import both components + `usePortalAuth` values (`d1User`, `isAdmin` — extend the existing destructure at line 66). Add state `const [activeTab, setActiveTab] = useState('files')` and `const wsAdmin = isAdmin || d1User?.workspacePermissions?.[slug] === 'admin'`. In the render, insert a tab bar between `.workspace__header` and the breadcrumbs:

```javascript
      <div className="workspace__tabs">
        <button className={`workspace__tab ${activeTab === 'files' ? 'workspace__tab--active' : ''}`} onClick={() => setActiveTab('files')}>Files</button>
        <button className={`workspace__tab ${activeTab === 'members' ? 'workspace__tab--active' : ''}`} onClick={() => setActiveTab('members')}>Members</button>
        {wsAdmin && (
          <button className={`workspace__tab ${activeTab === 'settings' ? 'workspace__tab--active' : ''}`} onClick={() => setActiveTab('settings')}>Settings</button>
        )}
      </div>

      {activeTab === 'members' && <MembersTab slug={slug} />}
      {activeTab === 'settings' && wsAdmin && (
        <WorkspaceSettingsTab slug={slug} workspace={workspace} onSaved={() => fetchWorkspace()} />
      )}
```

Wrap the existing files UI (breadcrumbs + `.workspace__content` block) in `{activeTab === 'files' && (<> … </>)}`. (During implementation, use the actual name of the function that loads workspace data for `onSaved` — extract from the existing `useEffect` if needed, same pattern as Task 7 Step 5.)

- [ ] **Step 4: Styles.** Append to `src/pages/WorkspaceDetail.css` (executive theme tokens only — `var(--accent)`, `var(--bg-*)`, `var(--text-*)`; no raw neon hex):

```css
.workspace__tabs { display: flex; gap: 0.25rem; margin: 1rem 0; border-bottom: 1px solid var(--border, #1A2740); }
.workspace__tab { background: none; border: none; color: var(--text-secondary); padding: 0.5rem 1rem; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; }
.workspace__tab--active { color: var(--text-primary); border-bottom-color: var(--accent); }
.members-table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
.members-table th, .members-table td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border, #1A2740); }
.members-chip { display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.72rem; background: var(--bg-elevated, #1A2740); color: var(--text-secondary); }
.members-chip--admin { color: var(--accent); }
.members-chip--pending { color: var(--warning, #cc8800); }
.members-invite { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
.members-invite input { flex: 1; }
.settings-tab { max-width: 480px; display: flex; flex-direction: column; gap: 0.75rem; align-items: flex-start; }
```

- [ ] **Step 5: Verify.** `npm run build` clean; `npx eslint src/` clean.
- [ ] **Step 6: Commit.**

```bash
git add src/components/workspace/ src/pages/WorkspaceDetail.jsx src/pages/WorkspaceDetail.css
git commit -m "feat(portal): workspace Members + Settings tabs"
```

---

### Task 9: Version bump + ordered deploy + migrations

**Files:**
- Modify: `package.json` (version)

**⚠️ Ordering is the whole point of this task: deploy the narrowed Worker BEFORE running the promotion migration.** Promotion under the old Worker code would grant Chris global access. Live-deploy steps that the harness's credential/deploy classifier blocks must be handed to Russ verbatim to run in his own terminal (same protocol as Phase 1 Task 8).

- [ ] **Step 1:** `package.json`: `"version": "0.3.0"` → `"version": "0.4.0"`. Run `npm run build`, confirm `grep -o '0\.4\.0' dist/assets/index-*.js | head -1` prints `0.4.0`.
- [ ] **Step 2: Commit the bump.**

```bash
git add package.json
git commit -m "chore(portal): bump to 0.4.0"
```

- [ ] **Step 3: Deploy the Worker** (narrowed authz goes live; roles unchanged, Chris still `client`): `cd worker && npx wrangler deploy`. Verify `curl -s https://api.warsignallabs.net/api/health` → healthy.
- [ ] **Step 4: Run migrations** (`invitations` table + promotions): from `portal-app/`, `npm run migrate`. Expected: `2 migration(s) applied` (002, 003). Verify:

```bash
npx wrangler d1 execute wsl-portal --remote --command "SELECT id, role, status FROM users WHERE id IN ('usr-003','usr-004')" --json
```

Expected: usr-003 `admin/active`, usr-004 `owner/active`.

- [ ] **Step 5: Deploy the frontend** (`.env` must be present — see Global Constraints): `npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true`. Verify live: v0.4.0 badge, admin nav visible for Russ.

---

### Task 10: Acceptance + ceiling verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Functional checklist (live, as Russ/admin):** sign in → all workspaces visible; open a workspace → Files/Members/Settings tabs render; Members lists members with role chips; create a test workspace via the sidebar modal → redirected in, creator listed as admin-permission member; Settings rename + color works; invite a test email with `read` → appears in pending list, email received; change the resulting member's permission to `write`; revoke a pending invite → disappears, membership row undone; admin pages all load.
- [ ] **Step 2: Ceiling tests (live, using Chris's owner account or a curl with an owner-scoped token — coordinate with Russ):** each of the following MUST return 403, and the delete/member ones must write an `audit_log` row:
  - `DELETE /api/workspaces/:slug` on ANY workspace, including one the owner created
  - `DELETE /api/files/:id` in a workspace where the owner holds only `write` (e.g. Chris in `lunch-out-of-landfills`)
  - `DELETE`/`PATCH .../members/usr-001` (targeting the global admin)
  - Downgrading/removing the last admin-permission member of a workspace
  - `GET /api/users`, `GET /api/audit-log`, `GET /api/admin/analytics`, `GET /api/dashboard/projects`
  - `GET /api/workspaces/:slug` for a workspace the owner has no membership in
  - Also verify positively: Chris CAN create a workspace, CAN manage members there, CAN rename it — and his UI shows no Admin/Operations nav.
  - Verify the denials appear: `npx wrangler d1 execute wsl-portal --remote --command "SELECT action, user_id, created_at FROM audit_log WHERE action LIKE '%.denied' ORDER BY created_at DESC LIMIT 10"`.
- [ ] **Step 3: Update `portal-app/handoff.yaml`** with a `session_<date>_phase2` entry (shipped items, prod versions, anything deferred).
- [ ] **Step 4: Push + PR.**

```bash
git push -u origin feat/portal-phase2-collab
gh pr create --title "feat(portal): Phase 2 — owner role with hard ceilings, members & invitations" --body "$(cat <<'EOF'
Phase 2 of portal-app/PORTAL_OVERHAUL_PLAN.md. Spec:
docs/superpowers/specs/2026-07-18-phase2-workspaces-members-permissions-design.md

## Changes
- Authz: owner is no longer a global bypass — only admin short-circuits
  workspace checks. Admin plane (users, audit log, analytics, ops) is
  admin-only. New pure helpers hasWorkspaceAdminPermission +
  memberChangeViolation with unit tests.
- Ceilings enforced server-side with denial audit rows: workspace delete
  admin-only always; file delete needs wsAdmin; member remove/downgrade
  never targets a global admin, never zeroes out the last admin-permission
  member.
- Members & invitations: list/patch/remove members; invite-by-email
  (pre-provisioned D1 user + membership, activated by requireAuth's email
  auto-map on first sign-in — no Clerk API dependency); revoke undoes the
  pre-created membership; Resend invitation email.
- Workspace create opens to owner with creator auto-membership (admin
  permission); workspace update (rename/color) opens to wsAdmin, quota
  stays admin-only.
- Frontend: Members + Settings tabs, sidebar New Workspace modal, admin
  plane hidden from owners, shared color palette. v0.4.0.
- Migrations: invitations table; usr-004 client->owner (Chris),
  usr-003 owner->admin (per Russ 2026-07-18).

## Verification
- Vitest: authz suite extended (owner-narrowing, wsAdmin, ceiling checks)
- Live ceiling tests: every §3.1 ceiling action as owner -> 403 + audit row
- Full functional pass on production (checklist in the plan's Task 10)
EOF
)"
```

- [ ] **Step 5:** Final whole-branch review per subagent-driven-development, then hand the PR to Russ.

---

## Self-Review

**Spec coverage:** §1 authz rewrite → Tasks 1–3 (incl. the two review-found widenings: `handleUpdateWorkspace` wsAdmin in Task 3 Step 2, `handleDeleteFile` in Step 3; `handleDeleteWorkspace` untouched-check in Step 4). §2 schema + promotions (incl. usr-003→admin) → Task 4, executed in order in Task 9. §3 acceptance wiring → Task 6 Step 3. §4 endpoints + edge rules (lowercase, already-member 409, already-pending 409) → Tasks 5–6. §5 frontend incl. de-privileging and sidebar button → Tasks 7–8. §6 testing → Task 1 (unit) + Task 10 (live ceilings). §7 color addendum → already shipped pre-plan (recorded in spec; `PRESET_COLORS` centralized in Task 7). §8 sequencing → task order + Task 9 ordering. Version bump → Task 9 Step 1.

**Placeholder scan:** clean — two intentional "follow the codebase if it differs" notes (modal CSS class names, workspace-refresh function name) are implementation-time lookups with stated defaults, not open-ended TBDs.

**Type consistency:** `hasWorkspaceAdminPermission(user, slug)` and `memberChangeViolation(targetRole, remainingAdminCount)` used identically in Tasks 1/3/5/6; api method names in Task 7 match Task 8's calls; `getWorkspaceBySlug` defined Task 5, used Task 6; router param names (`:slug`, `:userId`, `:id`) match `params.slug`/`params.userId`/`params.id` usage.
