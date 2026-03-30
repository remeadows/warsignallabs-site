# CONTEXT.md — WarSignalLabs Client Portal

**Version:** v0.2.0
**Last Updated:** 2026-03-30
**Owner:** Russell Meadows (WarSignalLabs)
**Linear Project:** [Client Portal (portal.warsignallabs.net)](https://linear.app/remeadows/project/client-portal-portalwarsignallabsnet-01fa033a)

---

## What This Is

A secure, multi-tenant client portal for WarSignalLabs. Clients log in, see only their assigned workspaces, and upload/download/replace documents. Admins manage users, workspaces, permissions, and receive email alerts on all portal activity. No passwords — Clerk handles passwordless authentication, D1 is the authoritative source for all authorization.

**Live URLs:**
- Portal: `https://portal.warsignallabs.net`
- API: `https://api.warsignallabs.net`
- Worker dev: `https://wsl-portal-api.russell-meadows.workers.dev`

---

## Stack

| Layer | Technology | Binding/Config |
|-------|-----------|----------------|
| Frontend | React 19 (Vite) | Cloudflare Pages (`wsl-portal`) |
| API | Cloudflare Worker | `wsl-portal-api` on `api.warsignallabs.net` |
| Database | Cloudflare D1 (SQLite) | `wsl-portal` / `9b47800b-5435-4e2c-890b-e38d2eea3f6a` |
| File Storage | Cloudflare R2 | `wsl-portal-files` |
| Auth | Clerk (passwordless) | JWT RS256, JWKS verification |
| Email | Resend | `portal@warsignallabs.net` |
| DNS/CDN | Cloudflare | Zone: `warsignallabs.net` |

---

## Architecture Decisions

**Auth vs Authz separation:** Clerk handles authentication only (passwordless login, JWT issuance). D1 is the single source of truth for authorization (roles, workspace assignments, permissions). Clerk publicMetadata is never used for access decisions.

**Three-tier RBAC:** `admin` > `owner` > `client`. Roles stored in `users.role` (D1). Workspace-level permissions (`read`, `write`, `admin`) stored in `user_workspaces.permission`.

**File versioning:** Replace-in-place model. Old versions archived to `file_versions` table with R2 keys preserved for rollback. No destructive overwrites.

**Notifications:** Fire-and-forget via Resend API using `ctx.waitUntil()`. Never blocks primary API response. All notifications logged to `notifications` table. Admins always receive alerts; client actors excluded from self-notification.

**Folder browser (v0.2.0):** Replaced the 4-tab category view with a hierarchical folder browser. `folders` table uses `parent_folder_id` for nesting. API returns `folders`, `files`, and `breadcrumbs` arrays per folder request. Frontend maintains `currentFolderId` (null=root) and renders breadcrumb nav with clickable path segments. Uploads target the current folder. Folder CRUD (create, rename, delete) and file move are gated behind workspace write permission. Delete blocks non-empty folders.

**Account deactivation:** Enforced at auth level in the Worker. All three auth resolution paths (clerk_id, email auto-map, username auto-map) check `users.status === 'inactive'` and return 403 before any route handler executes.

---

## D1 Schema

```
users            (id, username, email, role, status, clerk_id, created_at, updated_at)
workspaces       (id, name, slug, color, storage_quota_mb, storage_used_mb, created_at, updated_at)
user_workspaces  (id, user_id, workspace_id, permission, created_at)
folders          (id, workspace_id, parent_folder_id, name, created_by, created_at, updated_at)
files            (id, workspace_id, folder_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, version, created_at)
file_versions    (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at)
audit_log        (id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)
notifications    (id, event_type, workspace_id, recipient_email, recipient_user_id, subject, body_text, metadata_json, status, resend_id, created_at)
```

---

## Current Users (D1)

| ID | Username | Role | Email | Status |
|----|----------|------|-------|--------|
| usr-001 | armeadows | admin | russell.meadows@gmail.com | active |
| usr-002 | emergency-acct | admin | emergency@warsignallabs.net | active |
| usr-003 | rmeadows | client | remeadows@warsignallabs.net | active |
| usr-004 | cdepalma | client | cdepalma@blueprintadvisory.net | active |

---

## Workspaces

| ID | Name | Slug | Quota |
|----|------|------|-------|
| ws-001 | WarSignalLabs | warsignallabs | 2048 MB |
| ws-002 | Lunch out of Landfills | lunch-out-of-landfills | 2048 MB |
| ws-003 | Blueprint Advisory | blueprint-advisory | 2048 MB |

---

## API Endpoints

### Public
- `GET /api/health` — service health check

### Authenticated (all require Bearer JWT)
- `GET /api/me` — current user's D1-authoritative role + workspace permissions
- `GET /api/workspaces` — list workspaces (filtered by access)
- `GET /api/workspaces/:slug` — workspace detail with file count, member count, user permission
- `GET /api/workspaces/:slug/folders` — list root folder contents (folders + files, breadcrumbs)
- `GET /api/workspaces/:slug/folders/:folderId` — list folder contents by ID (folders + files, breadcrumbs)
- `POST /api/workspaces/:slug/folders` — create folder (name, parent_folder_id; requires workspace write)
- `PATCH /api/folders/:id` — rename folder (requires workspace write)
- `DELETE /api/folders/:id` — delete folder (must be empty; requires workspace write)
- `PATCH /api/files/:id/move` — move file to folder (folder_id; requires workspace write)
- `GET /api/workspaces/:slug/files` — list files (optional `?category=` filter)
- `POST /api/workspaces/:slug/files` — upload file (requires workspace write; optional folder_id)
- `PUT /api/files/:id` — replace file with new version (requires workspace write)
- `GET /api/files/:id/download` — stream file from R2
- `GET /api/files/:id/versions` — version history
- `DELETE /api/files/:id` — delete file (admin only)

### Admin
- `GET /api/users` — list all users
- `POST /api/users` — create user
- `PATCH /api/users/:id/role` — change role
- `POST /api/users/:id/deactivate` — disable account
- `POST /api/users/:id/activate` — re-enable account
- `GET /api/users/:id/workspaces` — user's workspace assignments
- `PATCH /api/users/:id/workspaces` — update workspace assignments
- `POST /api/workspaces` — create workspace
- `PATCH /api/workspaces/:slug` — update workspace
- `DELETE /api/workspaces/:slug` — delete workspace + all files
- `GET /api/audit-log` — audit log entries
- `GET /api/admin/analytics` — dashboard analytics

---

## Notification Events

| Event | Trigger | Recipients |
|-------|---------|------------|
| `file.upload` | File uploaded | Admins + workspace members |
| `file.download` | File downloaded | Admins + workspace members |
| `file.delete` | File deleted | Admins + workspace members |
| `file.replace` | File version replaced | Admins + workspace members |
| `user.create` | New user created | Admins only |
| `workspace.threshold` | Storage >= 75% of quota | Admins + workspace members |

Admins always receive notifications (never excluded). Client actors are excluded from self-notification.

---

## Secrets (Worker)

Set via `wrangler secret put`:
- `CLERK_SECRET_KEY` — Clerk Backend API key
- `CLERK_WEBHOOK_SECRET` — Clerk webhook verification (future)
- `RESEND_API_KEY` — Resend email API key

Environment variables (in `wrangler.toml`):
- `CLERK_FRONTEND_API` — Clerk frontend URL
- `RESEND_FROM_EMAIL` — `portal@warsignallabs.net`
- `RESEND_FROM_NAME` — `WarSignalLabs Portal`

---

## Deployment

```bash
# Worker (API)
cd portal-app/worker && npx wrangler deploy

# Frontend (Pages)
cd portal-app && npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true
```

---

## File Structure

```
portal-app/
├── worker/
│   ├── index.js          # Cloudflare Worker — API, auth, RBAC, notifications
│   └── wrangler.toml     # Worker config, D1/R2 bindings, env vars
├── src/
│   ├── App.jsx           # Router with auth-protected routes
│   ├── api/client.js     # API client hook (useApiClient)
│   ├── layouts/
│   │   ├── PortalLayout.jsx   # Sidebar + topnav (API-driven workspaces)
│   │   └── PortalLayout.css
│   ├── pages/
│   │   ├── Dashboard.jsx
│   │   ├── WorkspaceDetail.jsx
│   │   ├── WorkspaceDetail.css
│   │   ├── AdminUsers.jsx
│   │   ├── AdminWorkspaces.jsx
│   │   └── AuditLog.jsx
│   └── themes/
│       └── base.css      # Global styles, btn classes, version badge
├── public/
├── index.html
├── package.json
└── vite.config.js
```

---

*Updated 2026-03-30 by Claude (Cowork) — WarSignalLabs Portal v0.2.0*
