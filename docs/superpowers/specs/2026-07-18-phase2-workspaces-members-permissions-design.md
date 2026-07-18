# Phase 2 — Workspaces, Members, Permissions: Design

**Status:** Approved by Russ 2026-07-18. Source of truth for scope/behavior is
`portal-app/PORTAL_OVERHAUL_PLAN.md` §3.1/§3.2/§3.4/§3.5 and the Phase 2 execution
section (§4). This document captures the wiring-level decisions the plan states as
outcomes but doesn't spell out mechanically, plus the few implementation-detail
choices made during design, and one addendum (workspace color re-theme) that came
up during design review.

## Scope

Phase 2 = exactly: authz rewrite → `002_collab_core.sql` + `owner` role promotion →
members/invitations Worker endpoints → frontend (new-workspace modal, Members tab,
Settings tab) → invitation emails.

**Not in scope** (Phase 3/4 per the plan's phased execution section): comments,
projects/tasks, activity feed, notification center, Home redesign.

## 1. Authz rewrite (must land and be verified before role promotion — §3.1's explicit ordering)

Ceiling logic is implemented as small, pure, directly-unit-testable functions in
`worker/src/auth.js` — the same pattern as the existing
`requireRole`/`requireWorkspaceAccess`/`hasWorkspaceWriteAccess`, extended:

- `requireWorkspaceAccess` / `hasWorkspaceWriteAccess`: narrow the global bypass from
  `role === 'admin' || role === 'owner'` to `role === 'admin'` only. `owner` falls
  through to the same per-workspace `workspacePermissions` check as `client`.
- New `hasWorkspaceAdminPermission(user, workspaceSlug)` — the `wsAdmin` concept from
  §3.5: true if `user.role === 'admin'`, or if `user.workspacePermissions[slug] === 'admin'`.
- New `canRemoveOrDowngradeMember(targetUser, wouldRemainAdminPermissionCount)` —
  returns false (blocks the action) if `targetUser.role === 'admin'` (a global admin
  can never be removed or have their workspace permission downgraded by anyone —
  §3.1: *"a global admin cannot be removed, downgraded, or locked out of any
  workspace by an owner"*), or if the resulting admin-permission member count for
  that workspace would be zero. Both guards apply identically whether the caller is
  hitting `DELETE /members/:userId` (remove) or `PATCH /members/:userId`
  (permission change/downgrade) — a downgrade that would zero out the workspace's
  last admin-permission member is blocked exactly like a removal would be, and
  downgrading a global admin's workspace-permission row is blocked exactly like
  removing them would be (even though it wouldn't reduce their actual access, since
  `admin` role bypasses per-workspace permission entirely — the DB record itself
  must not be touched this way).

### Call-site audit (every current `requireRole(user, 'admin', 'owner')` site)

| Handler | File | Current | Target |
|---|---|---|---|
| `handleListUsers` | routes/users.js:11 | admin+owner | **admin-only** |
| `handleDeactivateUser` | routes/users.js:140 | admin+owner | **admin-only** |
| `handleActivateUser` | routes/users.js:165 | admin+owner | **admin-only** |
| `handleGetUserWorkspaces` | routes/workspaces.js:196 | admin+owner | **admin-only** |
| `handleUpdateUserWorkspaces` | routes/workspaces.js:216 | admin+owner | **admin-only** |
| `handleAuditLog` | routes/admin.js:37 | admin+owner | **admin-only** |
| `handleAdminAnalytics` | routes/admin.js:87 | admin+owner | **admin-only** |
| `handleDashboardProjects` | routes/admin.js:136 | admin+owner | **admin-only** (ops dashboard; plan's blanket rule covers this even though it's not in the explicit ceiling-test list) |
| `handleCreateWorkspace` | routes/workspaces.js:91 | admin-only | **admin+owner** (the one endpoint that widens, per §3.2.1) |

### Delete-path corrections (found by reading the actual code, not just the plan)

- `handleDeleteFile` (routes/files.js:420-421) is currently `requireRole(user, 'admin')`
  — **narrower** than the target. Must **widen** to `admin OR hasWorkspaceAdminPermission`.
- `handleDeleteWorkspace` (routes/workspaces.js:164-165) is already correctly
  `requireRole(user, 'admin')` — **must not change**. This is the one place a mistake
  would directly violate Russ's original hard constraint ("owner can never delete a
  workspace, even one they created").
- `handleDeleteFolder` (routes/folders.js:216-227) needs **no change**. Non-empty
  folder delete isn't an implemented capability today (always returns 409 regardless
  of role/permission) — that's a future capability, not something Phase 2 builds.
  Empty-folder delete is already correctly gated at write-tier
  (`hasWorkspaceWriteAccess`), matching the plan's stated target exactly.

## 2. Schema — `002_collab_core.sql`

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,               -- inv-<nanoid>
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read','write','admin')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
-- users.status gains 'invited' as a valid value (app-level only; column is TEXT already)
```

Then, as a migration (with Russ's confirmation before running): `UPDATE users SET
role='owner' WHERE id='usr-004'` — only after the authz rewrite above is merged and
verified.

## 3. Invitation-acceptance wiring (mechanical detail not spelled out in the plan)

The plan states the outcome: *"inviting chris@x.com creates a users row
(status='invited') + user_workspaces row + a Resend email... On first sign-in, the
Worker's existing email auto-map in requireAuth attaches the Clerk identity and flips
status to active."*

Concretely: `requireAuth`'s existing email-matching branch (`worker/src/auth.js`,
the same code path touched for the PR #26 security fix) gains two additions when it
successfully maps a Clerk identity to a D1 user by email:

1. If that user's `status` was `'invited'`, update it to `'active'`.
2. Look up any `pending` invitation row for that email + the workspace(s) just
   resolved, and mark it `accepted` (set `accepted_at`).

This reuses the existing successful-mapping code path rather than introducing a new
endpoint or a frontend-driven "accept invitation" step.

## 4. New API endpoints (verbatim from §3.5)

```
GET    /api/workspaces/:slug/members                  (member)
PATCH  /api/workspaces/:slug/members/:userId          (wsAdmin)   body: {permission}
DELETE /api/workspaces/:slug/members/:userId          (wsAdmin; never a global admin; never the last admin-permission member)
POST   /api/workspaces/:slug/invitations              (wsAdmin)   body: {email, permission}
GET    /api/workspaces/:slug/invitations              (wsAdmin)
DELETE /api/invitations/:id                           (wsAdmin)   -- revoke
POST   /api/workspaces                                (EXTEND: allow role owner; creator auto-membership permission=admin)
```

Inviting an email with no existing `users` row creates one (`status='invited'`,
`role='client'`) + the `user_workspaces` row + the `invitations` row. Inviting an
email that already has a D1 user only adds the `user_workspaces` + `invitations` rows.

## 5. Frontend

- **"New workspace" button** in the sidebar (per §3.3), visible to admin + owner.
  Modal: name, auto-slug from name (kebab-case, numeric-suffix on collision), color
  picker (existing `PRESET_COLORS` from Task 9 — already a professional muted
  palette, no change needed here).
- **Members tab** inside `WorkspaceDetail.jsx`: member list with permission dropdown
  + remove, invite-by-email form, pending-invites list with revoke. Edit controls
  render only for wsAdmin — server-side checks are the actual enforcement, this is
  UI convenience only.
- **Settings tab** (rename, color) for wsAdmin.

## 6. Testing

Pure ceiling functions get direct Vitest unit tests with mocked user/workspace
objects (same pattern as `auth.test.js` from Phase 1) — no live tokens needed.
Required negative cases per §3.1: owner attempting each ceiling action (workspace
delete, file delete outside their admin-permission workspaces, member
remove/downgrade against the global admin, hitting `/api/users`, `/api/audit-log`,
`/api/admin/analytics`) against a Russ-owned workspace → 403.

## 7. Addendum: workspace color re-theme (raised during design review)

The screenshot Russ shared showed workspace names/sidebar dots still in the old neon
palette (`#00c8d4`, `#39ff14`, `#ffaa00`, `#ff6b9d`) — these are **data values**
stored per-workspace in D1 from before the Task 9 retheme, which only updated the
color-picker presets and CSS tokens, not existing records.

**Already done (2026-07-18, ahead of the rest of Phase 2):**
- Verified the color-picker's `PRESET_COLORS` in `AdminWorkspaces.jsx` were already
  updated by Task 9 to a professional muted palette (steel-blue `#6F8FB8`, muted
  green `#4C9A6B`, amber `#E6A51A`, gold `#C9A557`, muted purple `#9D7FB8`, muted
  cyan `#4CA3C9`, terracotta `#D97757`) — no further picker work needed.
- Re-colored the 4 existing production workspaces from that same palette, preserving
  each workspace's rough hue identity: `warsignallabs` cyan→`#4CA3C9`,
  `lunch-out-of-landfills` green→`#4C9A6B`, `blueprint-advisory` amber→`#E6A51A`,
  `let-s-go-compost` pink→`#9D7FB8` (no direct pink equivalent in the palette; muted
  purple is the closest analog). Verified via a live D1 query and visually in the
  browser.

## 8. Task sequencing (one PR, ordered exactly per §3.1's mandate)

Subagent-driven-development, same model as Phase 1 — fresh implementer + task review
per task, final whole-branch review before merge:

1. Authz rewrite (§1 above) + unit tests — reviewed and verified clean **before**
   step 2 starts. Non-negotiable ordering per §3.1.
2. `002_collab_core.sql` + `role='owner'` promotion for Chris (`usr-004`) — only
   after step 1 passes review.
3. Members/invitations Worker endpoints (§4), including the `requireAuth`
   invitation-acceptance wiring (§3).
4. Frontend (§5): sidebar button, new-workspace modal, Members tab, Settings tab.
5. Invitation emails via the existing Resend path; `member.invite`/`member.join`
   audit + notification events.
6. Full acceptance pass: functional checklist + all ceiling tests, live against
   production — mirrors Phase 1's Task 11.
