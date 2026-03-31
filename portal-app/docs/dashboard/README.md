# Operational Dashboard

Internal project visibility layer for WarSignalLabs admin users. This is **not** a client workspace — it provides operational oversight of all active projects across the organization.

## Who Has Access

Admin-only. Access requires both:
1. **Clerk authentication** (signed in)
2. **D1 role = `admin` or `owner`**

Currently authorized users:
- `rmeadows` (admin)
- `emeadows` (admin)

Non-admin users who navigate to `/dashboard/*` are redirected to `/forbidden`. Anonymous users are redirected to the Clerk sign-in page.

## Auth Flow

```
Browser → /dashboard/projects
  │
  ├─ Not signed in?
  │    └─ Clerk <SignedOut> → redirect to sign-in
  │
  ├─ Signed in, not admin/owner?
  │    └─ DashboardLayout checks isPrivileged → redirect to /forbidden
  │
  └─ Signed in + admin/owner
       ├─ Frontend renders DashboardLayout + DashboardProjects
       └─ API call: GET /api/dashboard/projects
            └─ Worker: requireRole(user, 'admin', 'owner')
                 ├─ ✅ returns projects JSON
                 └─ ❌ returns 403 Forbidden
```

Three independent auth layers protect the dashboard:
1. **Clerk** — session-level (unauthenticated → sign-in)
2. **React** — DashboardLayout component gate (non-admin → /forbidden)
3. **Worker** — requireRole on every API call (non-admin → 403)

## URL Structure

| Path | Component | Description |
|------|-----------|-------------|
| `/` | Home | Workspace overview (all users) |
| `/workspace/:slug` | WorkspaceDetail | Client workspace file browser |
| `/dashboard` | DashboardLayout | Ops dashboard (redirects to /dashboard/projects) |
| `/dashboard/projects` | DashboardProjects | Project list with filters/sorting |

## How to Update the Projects List

v0.2.2 uses file-based data embedded in the Worker at deploy time. To update:

1. **Export from Linear** — Use the Linear MCP tool or API to fetch all projects:
   ```
   list_projects → transform to schema → save to data/projects.json
   ```

2. **Schema** — Each project in `data/projects.json`:
   ```json
   {
     "id": "uuid-prefix",
     "title": "Project Name",
     "category": "WebApps|Games|Enterprise|Infrastructure|...",
     "priority": 1,
     "status": "In Progress|Planned|Backlog|Completed",
     "linearUrl": "https://linear.app/...",
     "repoUrl": "https://github.com/...",
     "targetDate": "2026-03-31"
   }
   ```

3. **Update the Worker** — Copy the updated data into `DASHBOARD_PROJECTS_DATA` in `worker/index.js`

4. **Deploy** — Build frontend + deploy Worker

Future versions will read from D1 or fetch directly from the Linear API.

## Architecture

```
portal-app/
├── src/
│   ├── layouts/
│   │   ├── DashboardLayout.jsx   ← auth gate + sidebar shell
│   │   └── DashboardLayout.css
│   └── pages/
│       └── DashboardProjects.jsx ← projects table with filters
├── data/
│   └── projects.json             ← source-of-truth export
└── worker/
    └── index.js                  ← DASHBOARD_PROJECTS_DATA + /api/dashboard/projects
```

## Future Expansion

The dashboard sidebar includes placeholder items for planned sections:

| Section | Status | Description |
|---------|--------|-------------|
| **Projects** | Live (v0.2.2) | All Linear projects with filter/sort |
| **Business Docs** | Future | Internal ops documents (SOPs, runbooks) |
| **GW-OS Briefs** | Future | Agent swarm status briefs from GW-OS pipeline |

To add a new section:
1. Create a page component in `src/pages/Dashboard*.jsx`
2. Add a route under the `dashboard` parent in `App.jsx`
3. Add a NavLink in `DashboardLayout.jsx` (replace the `<span>` placeholder)
4. If it needs data, add a Worker endpoint under `/api/dashboard/*` with `requireRole`
