# Portal Phase 1 — Foundation (Worker modularization, D1 migrations, executive retheme, hygiene) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase 1 of `portal-app/PORTAL_OVERHAUL_PLAN.md` — split the 2,607-line `worker/index.js` monolith into ES modules with byte-identical behavior, add a D1 migration scaffold, replace the portal's cyberpunk theme with the executive identity the marketing site already shipped, and land the cheap hygiene wins (version badge, first tests). **No user-visible behavior change** except the visual retheme.

**Architecture:** `worker/index.js` becomes a ~10-line entry point that imports and re-exports a `fetch` handler assembled in `worker/src/router.js`. That router imports route handlers from `worker/src/routes/*.js`, and shared helpers from `worker/src/{cors,auth,audit,notify}.js`. Every moved function keeps its exact current body — only its file location, the `export` keyword, and its imports change. A smoke-test script captures every GET endpoint's response against the live worker before the refactor and diffs it against the same script's output after deploying, catching any accidental behavior change. The frontend gets a new `src/themes/executive.css` swapped in for `dark-professional.css`; because every component already consumes colors via CSS custom properties (`var(--accent)`, etc.), swapping the token file is sufficient — no component CSS needs to change.

**Tech Stack:** Cloudflare Workers (ES modules), Vite 8 + React 19, D1 (SQLite), Vitest (new), Node.js for the migration/smoke scripts.

## Global Constraints

- **No user-visible behavior change** from the Worker refactor — every existing endpoint must return byte-identical responses for the same input, verified by the smoke script.
- **Migrations are additive-only** — no destructive `ALTER`/`DROP` (per `PORTAL_OVERHAUL_PLAN.md` §5).
- **Kill-list must return zero** in `portal-app/src` after the retheme: `[ MENU ]`, `[ CLOSE ]`, `Share Tech Mono`, `#39ff14`, `#00c8d4` (per `PORTAL_OVERHAUL_PLAN.md` §3.3).
- **D1 database:** `wsl-portal` (id `9b47800b-5435-4e2c-890b-e38d2eea3f6a`), binding `DB`. All `wrangler d1 execute` commands in this plan target `--remote` (there is no local/staging D1 — per `CONTEXT.md`, "no staging env — acceptable").
- **Deploy commands** (from `portal-app/CONTEXT.md`):
  - Worker: `cd portal-app/worker && npx wrangler deploy`
  - Frontend: `cd portal-app && npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true`
- **Version bump:** `portal-app/package.json` version goes from `0.0.0` to `0.3.0` at the end of this phase (per `PORTAL_OVERHAUL_PLAN.md` Phase 1 acceptance).
- **Branch:** work happens on a new branch `feat/portal-phase1-foundation` off `main`. Commit after every task.
- **Scope trim (flag to Russ, don't silently drop):** `PORTAL_OVERHAUL_PLAN.md` §3.2.4's "Hygiene" bullet also lists "extract shared frontend components (`Modal`, `Toast`, `EmptyState`, `ConfirmDialog`)". Investigation for this plan found 4+ hand-rolled modal instances in `WorkspaceDetail.jsx` alone (plus a native `confirm()` call) with no shared component today. Componentizing all of that correctly is a substantial, separate-feeling change with real design-judgment calls (a full audit found it touches at minimum `WorkspaceDetail.jsx`, `AdminUsers.jsx`, `AdminWorkspaces.jsx`, `AdminAuditLog.jsx`). **This plan does NOT include it** — it's deferred to its own follow-up task so Phase 1 stays a clean, reviewable "no behavior change" PR. The version-badge and Vitest hygiene items ARE included below.

---

## Investigation summary (context the plan below relies on)

**`worker/index.js` function inventory** (2,607 lines total), by target module:

| Target file | Functions/consts moving in | Current line range |
|---|---|---|
| `worker/src/cors.js` | `CORS_HEADERS`, `SECURITY_HEADERS`, `jsonResponse`, `errorResponse` | 19–77 |
| `worker/src/auth.js` | `getJwks`, `base64urlDecode`, `decodeJwt`, `importJwk`, `verifyJwt`, `fetchClerkUser` (+ `clerkUserCache`, `CLERK_CACHE_TTL_MS`), `requireAuth`, `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess` | 83–427 (skip 429–453 audit section) |
| `worker/src/audit.js` | `logAudit`, `getClientIp` | 433–457 |
| `worker/src/notify.js` | `sendEmail`, `resolveRecipients`, `buildEmailHtml`, `notifyWorkspaceEvent`, `checkStorageThreshold` | 463–673 |
| `worker/src/router.js` | `matchPath` (679–696) + the `export default { fetch }` dispatch (2405–2607) | 679–696, 2405–2607 |
| `worker/src/routes/me.js` | `handleHealth` (702–711), plus a new `handleMe` extracted from the inline `/api/me` block (2434–2442) | 702–711 |
| `worker/src/routes/workspaces.js` | `handleListWorkspaces`, `handleGetWorkspace`, `handleCreateWorkspace`, `handleUpdateWorkspace`, `handleDeleteWorkspace`, `handleGetUserWorkspaces`, `handleUpdateUserWorkspaces` | 716–792, 1981–2039, 2040–2145 |
| `worker/src/routes/files.js` | `ALLOWED_MIME_TYPES`, `VALID_CATEGORIES`, `MAX_FILE_SIZE`, `handleListFiles`, `handleUploadFile`, `handleReplaceFile`, `handleGetFileVersions`, `handleDeleteFile`, `handleDownloadFile`, `handleMoveFile` | 798–1156, 1599–1660 |
| `worker/src/routes/folders.js` | `validateFolderName`, `handleListFolderContents`, `handleCreateFolder`, `handleRenameFolder`, `handleDeleteFolder`, `handleMoveFolder` | 1333–1598, 1661–1751 |
| `worker/src/routes/users.js` | `handleListUsers`, `handleCreateUser`, `handleChangeRole`, `handleDeactivateUser`, `handleActivateUser` | 1752–1786, 1934–1980, 2146–2240 |
| `worker/src/routes/admin.js` | `DASHBOARD_PROJECTS_DATA`, `handleAuditLog`, `handleAdminAnalytics`, `handleDashboardProjects` | 37–57, 1787–1933 |
| `worker/src/routes/briefs.js` | `verifyServiceKey`, `_parseBriefRow`, `handlePostBrief`, `handleListBriefs`, `handleGetLatestBrief`, `handleGetBrief` | 2241–2399 |

**The only valid cross-module import sources** are the four shared files above. If a moved function references a name not defined in its own new file, it MUST come from exactly one of: `cors.js` (`jsonResponse`, `errorResponse`), `auth.js` (`requireAuth`, `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess`), `audit.js` (`logAudit`, `getClientIp`), `notify.js` (`notifyWorkspaceEvent`, `checkStorageThreshold`). There are no other legitimate cross-file references — if you hit a `ReferenceError` for anything else, you moved something to the wrong file; don't invent a new shared module.

**Frontend retheme scope** (confirmed by grep across `portal-app/src`):
- Kill-list hits: `[ MENU ]` / `[ CLOSE ]` in `src/layouts/PortalLayout.jsx:72`; `// Dashboard`/`// Admin`/`// Settings`/`// Workspace`/`// Operations Dashboard` kickers in `Home.jsx`, `Dashboard.jsx` (dead — see below), `Settings.jsx`, `AdminUsers.jsx`, `AdminWorkspaces.jsx`, `AdminAuditLog.jsx`, `WorkspaceDetail.jsx`, `DashboardLayout.jsx`; hardcoded `#00c8d4`/`#39ff14` in `AdminWorkspaces.jsx`'s `PRESET_COLORS` array (lines 15, 27, 87); `Share Tech Mono` and the old Google Fonts import in `src/themes/base.css:6`.
- **`src/pages/Dashboard.jsx` is a confirmed dead duplicate of `Home.jsx`** (`diff` shows the only difference is the function name) — it is never imported by `App.jsx`. Delete it as part of this phase's cleanup rather than retheme two copies of the same file. `Dashboard.css` stays — `Home.jsx` imports it too.
- The `--ws-warsignallabs`/`--ws-landfills`/`--ws-blueprint` CSS variables in `dark-professional.css` are dead (zero `var(--ws-` references anywhere) — do not carry them into the new theme file.
- All color consumption elsewhere goes through CSS custom properties (`var(--accent)`, `var(--bg-primary)`, etc.) defined in `src/themes/dark-professional.css` and consumed in `src/themes/base.css` and page CSS files — swapping the one token file at `src/main.jsx`'s import is sufficient; no other CSS file needs edits for the retheme itself.
- `src/pages/WorkspaceDetail.css:181` has one unrelated hardcoded hex (`#ffc832`, a folder-icon badge color) — not on the kill-list, out of scope, leave it.

---

### Task 1: Branch setup + D1 migration scaffold

**Files:**
- Create: `portal-app/worker/migrations/000_baseline.sql`
- Create: `portal-app/worker/migrations/001_schema_migrations.sql`
- Create: `portal-app/worker/scripts/migrate.js`
- Modify: `portal-app/package.json` (add `"migrate"` script)

**Interfaces:**
- Produces: `npm run migrate` (run from `portal-app/`) — applies any `.sql` files under `worker/migrations/` not yet recorded in the `schema_migrations` table, in filename order, against the remote `wsl-portal` D1 database.

- [ ] **Step 1: Create the branch**

```bash
cd "portal-app/.." 2>/dev/null; cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site"
git checkout main && git pull --ff-only
git checkout -b feat/portal-phase1-foundation
```

- [ ] **Step 2: Write the schema_migrations bootstrap migration**

Create `portal-app/worker/migrations/001_schema_migrations.sql`:

```sql
-- 001_schema_migrations.sql
-- Tracks which migration files have been applied. Bootstrapped separately
-- by migrate.js (idempotent CREATE TABLE IF NOT EXISTS) before any numbered
-- migration runs, so this file mainly documents the table for readers.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3: Write the baseline migration documenting the current schema**

Create `portal-app/worker/migrations/000_baseline.sql` (every statement is `IF NOT EXISTS` — a true no-op against the current production database, which already has all of these tables):

```sql
-- 000_baseline.sql
-- Documents the schema as it exists in production today (pre-migration-system).
-- Every statement is IF NOT EXISTS: applying this to the existing prod database
-- is a no-op. New/local databases get the real schema from this file.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'owner', 'client')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  clerk_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  color TEXT,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_folder_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  folder_id TEXT REFERENCES folders(id),
  category TEXT,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id),
  version_number INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  workspace_id TEXT,
  recipient_email TEXT,
  recipient_user_id TEXT,
  subject TEXT,
  body_text TEXT,
  metadata_json TEXT,
  status TEXT,
  resend_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  content_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Write the migrate script**

Create `portal-app/worker/scripts/migrate.js`:

```javascript
#!/usr/bin/env node
// Applies pending SQL files in worker/migrations/ (sorted by filename) to the
// remote wsl-portal D1 database, tracking applied migrations in
// schema_migrations. Idempotent: re-running with nothing new is a no-op.

import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const workerDir = path.resolve(__dirname, '..')
const migrationsDir = path.join(workerDir, 'migrations')
const DB_NAME = 'wsl-portal'

function runD1(args) {
  const cmd = `npx wrangler d1 execute ${DB_NAME} --remote ${args}`
  return execSync(cmd, { cwd: workerDir, encoding: 'utf8' })
}

function runD1Json(args) {
  const out = runD1(`${args} --json`)
  // wrangler prints banner lines before the JSON array; find the first '['
  const start = out.indexOf('[')
  return JSON.parse(out.slice(start))
}

function bootstrap() {
  console.log('Ensuring schema_migrations table exists...')
  runD1(`--command "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"`)
}

function getAppliedMigrations() {
  const result = runD1Json(`--command "SELECT name FROM schema_migrations"`)
  const rows = result[0]?.results || []
  return new Set(rows.map((r) => r.name))
}

function applyMigration(filename) {
  const filePath = path.join(migrationsDir, filename)
  console.log(`Applying ${filename}...`)
  runD1(`--file "${filePath}"`)
  const escapedName = filename.replace(/'/g, "''")
  runD1(`--command "INSERT INTO schema_migrations (name) VALUES ('${escapedName}')"`)
  console.log(`Applied ${filename}`)
}

function main() {
  bootstrap()
  const applied = getAppliedMigrations()
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('No migration files found in worker/migrations/.')
    return
  }

  let appliedCount = 0
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied)`)
      continue
    }
    applyMigration(file)
    appliedCount++
  }

  console.log(`Done. ${appliedCount} migration(s) applied, ${files.length - appliedCount} already up to date.`)
}

main()
```

- [ ] **Step 5: Wire up the npm script**

In `portal-app/package.json`, add to `"scripts"`:

```json
    "migrate": "node worker/scripts/migrate.js"
```

(Full `scripts` block becomes: `"dev": "vite", "build": "vite build", "lint": "eslint .", "preview": "vite preview", "migrate": "node worker/scripts/migrate.js"`)

- [ ] **Step 6: Run it and verify idempotency**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
npm run migrate
```

Expected output ends with `Done. 2 migration(s) applied, 0 already up to date.`

Run it again immediately:

```bash
npm run migrate
```

Expected output ends with `Done. 0 migration(s) applied, 2 already up to date.` — confirms idempotency.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations worker/scripts/migrate.js package.json
git commit -m "feat(portal): add D1 migration scaffold

schema_migrations tracks applied migrations. 000_baseline documents
the current production schema (no-op via IF NOT EXISTS). npm run
migrate applies pending .sql files in worker/migrations/, idempotent."
```

---

### Task 2: Extract `cors.js` (response helpers)

**Files:**
- Create: `portal-app/worker/src/cors.js`
- Modify: `portal-app/worker/index.js:19-77` (remove — moved out)

**Interfaces:**
- Produces: `CORS_HEADERS`, `SECURITY_HEADERS`, `jsonResponse(data, status = 200, extraHeaders = {})`, `errorResponse(message, status = 400)` — all named exports.

- [ ] **Step 1: Create the file**

Create `portal-app/worker/src/cors.js` by cutting lines 19–77 from `worker/index.js` verbatim (the `CORS_HEADERS` const through the end of `errorResponse`), and add `export` in front of each:

```javascript
// worker/src/cors.js
// CORS + security headers, and the two response-shaping helpers every route uses.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  })
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status)
}
```

- [ ] **Step 2: Delete lines 19–77 from `worker/index.js`**

Remove the section header comment (`// ═══... Constants & Shared Headers ═══...`) and the four items above from `index.js` — they now live in `cors.js`. Leave everything else in `index.js` untouched for now (later tasks will remove it section by section).

- [ ] **Step 3: Commit**

```bash
git add worker/src/cors.js worker/index.js
git commit -m "refactor(portal): extract cors.js from worker/index.js

Pure move — CORS_HEADERS, SECURITY_HEADERS, jsonResponse, errorResponse.
index.js still has everything else; later tasks finish the split."
```

---

### Task 3: Extract `audit.js`

**Files:**
- Create: `portal-app/worker/src/audit.js`
- Modify: `portal-app/worker/index.js:433-457` (remove — moved out)

**Interfaces:**
- Consumes: nothing cross-file (uses only `env.DB` and the global `crypto`).
- Produces: `logAudit(env, userId, action, details = {})`, `getClientIp(request)`.

- [ ] **Step 1: Create the file**

Create `portal-app/worker/src/audit.js` by cutting lines 433–457 from `worker/index.js` verbatim:

```javascript
// worker/src/audit.js
// Every mutation writes an audit_log row. Never blocks the response on failure.

export async function logAudit(env, userId, action, details = {}) {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        id,
        userId,
        action,
        details.resourceType || null,
        details.resourceId || null,
        JSON.stringify(details),
        details.ipAddress || null,
      )
      .run()
  } catch (err) {
    console.error('Audit log write failed:', err.message)
  }
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}
```

- [ ] **Step 2: Delete lines 433–457 (and the `// Audit Logging` section header) from `worker/index.js`**

- [ ] **Step 3: Commit**

```bash
git add worker/src/audit.js worker/index.js
git commit -m "refactor(portal): extract audit.js from worker/index.js

Pure move — logAudit, getClientIp."
```

---

### Task 4: Extract `notify.js`

**Files:**
- Create: `portal-app/worker/src/notify.js`
- Modify: `portal-app/worker/index.js:463-673` (remove — moved out)

**Interfaces:**
- Consumes: nothing cross-file (uses only `env.RESEND_API_KEY`/`env.RESEND_FROM_EMAIL`/`env.RESEND_FROM_NAME`, `env.DB`).
- Produces: `sendEmail(env, {...})`, `resolveRecipients(env, workspaceId)`, `buildEmailHtml(title, bodyLines)`, `notifyWorkspaceEvent(env, ctx, {...})`, `checkStorageThreshold(env, ctx, {...})`.

- [ ] **Step 1: Create the file**

Create `portal-app/worker/src/notify.js` by cutting lines 463–673 from `worker/index.js` verbatim (`sendEmail` through the end of `checkStorageThreshold`), adding `export` to each of the five top-level declarations. Note `notifyWorkspaceEvent` internally calls `sendEmail`, and `checkStorageThreshold` internally calls `notifyWorkspaceEvent` — both stay same-file calls, no import needed for those two.

```javascript
// worker/src/notify.js
// Fire-and-forget email notifications via Resend, using ctx.waitUntil() so
// the primary API response is never blocked.

export async function sendEmail(env, { to, subject, html, text, eventType, workspaceId, recipientUserId, metadata }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email notification')
    return null
  }

  const fromEmail = env.RESEND_FROM_EMAIL || 'portal@warsignallabs.net'
  const fromName = env.RESEND_FROM_NAME || 'WarSignalLabs Portal'

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || undefined,
        text: text || subject,
      }),
    })

    const result = await response.json()
    const resendId = result.id || null
    const status = response.ok ? 'sent' : 'failed'

    if (!response.ok) {
      console.error('Resend API error:', JSON.stringify(result))
    }

    const notifId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO notifications (id, event_type, workspace_id, recipient_email, recipient_user_id, subject, body_text, metadata_json, status, resend_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      notifId,
      eventType || 'general',
      workspaceId || null,
      Array.isArray(to) ? to.join(', ') : to,
      recipientUserId || null,
      subject,
      text || subject,
      metadata ? JSON.stringify(metadata) : null,
      status,
      resendId,
    ).run()

    return { id: resendId, status }
  } catch (err) {
    console.error('Email send failed:', err.message)
    return null
  }
}

export async function resolveRecipients(env, workspaceId) {
  const admins = await env.DB.prepare(
    "SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL",
  ).all()

  let members = { results: [] }
  if (workspaceId) {
    members = await env.DB.prepare(
      `SELECT u.id, u.email FROM users u
       INNER JOIN user_workspaces uw ON uw.user_id = u.id
       WHERE uw.workspace_id = ? AND u.status = 'active' AND u.email IS NOT NULL`,
    ).bind(workspaceId).all()
  }

  return {
    admins: admins.results.map((u) => ({ email: u.email, userId: u.id })),
    workspaceMembers: members.results.map((u) => ({ email: u.email, userId: u.id })),
  }
}

export function buildEmailHtml(title, bodyLines) {
  const lines = bodyLines.map((l) => `<p style="margin:4px 0;color:#333;">${l}</p>`).join('')
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="border-bottom:3px solid #00c8d4;padding-bottom:12px;margin-bottom:20px;">
    <h2 style="margin:0;color:#0a0a0a;">WarSignalLabs Portal</h2>
    <span style="font-size:0.75rem;color:#888;">v0.1.0</span>
  </div>
  <h3 style="color:#0a0a0a;margin-bottom:8px;">${title}</h3>
  ${lines}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
  <p style="font-size:0.75rem;color:#999;">This is an automated notification from portal.warsignallabs.net</p>
</body>
</html>`
}

export function notifyWorkspaceEvent(env, ctx, { eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata }) {
  const task = (async () => {
    try {
      const { admins, workspaceMembers } = await resolveRecipients(env, workspaceId)

      const adminEmails = new Set(admins.map((a) => a.email.toLowerCase()))

      const allRecipients = new Map()
      for (const r of [...admins, ...workspaceMembers]) {
        if (!r.email) continue
        const emailLower = r.email.toLowerCase()
        const isActor = emailLower === (actorEmail || '').toLowerCase()
        const isAdmin = adminEmails.has(emailLower)
        if (isAdmin || !isActor) {
          allRecipients.set(emailLower, r)
        }
      }

      if (allRecipients.size === 0) return

      const subject = `[WSL Portal] ${title}`
      const html = buildEmailHtml(title, bodyLines)
      const text = bodyLines.join('\n')

      for (const [email, recipient] of allRecipients) {
        await sendEmail(env, {
          to: email,
          subject,
          html,
          text,
          eventType,
          workspaceId,
          recipientUserId: recipient.userId,
          metadata,
        })
      }
    } catch (err) {
      console.error('notifyWorkspaceEvent failed:', err.message)
    }
  })()

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
}

export function checkStorageThreshold(env, ctx, { workspaceId, workspaceName, workspaceSlug, actorEmail }) {
  const task = (async () => {
    try {
      const ws = await env.DB.prepare(
        'SELECT storage_quota_mb FROM workspaces WHERE id = ?',
      ).bind(workspaceId).first()
      if (!ws || !ws.storage_quota_mb) return

      const usage = await env.DB.prepare(
        'SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM files WHERE workspace_id = ?',
      ).bind(workspaceId).first()

      const usedMb = (usage?.total_bytes || 0) / (1024 * 1024)
      const quotaMb = ws.storage_quota_mb
      const pct = Math.round((usedMb / quotaMb) * 100)

      if (pct >= 75) {
        notifyWorkspaceEvent(env, ctx, {
          eventType: 'workspace.threshold',
          workspaceId,
          workspaceName: workspaceName || workspaceSlug,
          title: `Storage Alert: ${workspaceName || workspaceSlug} at ${pct}%`,
          bodyLines: [
            `<strong>Workspace:</strong> ${workspaceName || workspaceSlug}`,
            `<strong>Storage Used:</strong> ${usedMb.toFixed(1)} MB of ${quotaMb} MB (${pct}%)`,
            `<strong>Status:</strong> ${pct >= 90 ? '🔴 Critical' : '🟡 Warning'} — storage is ${pct >= 90 ? 'nearly full' : 'approaching capacity'}`,
            `Consider archiving old files or increasing the workspace quota.`,
          ],
          actorEmail: null,
          metadata: { usedMb: usedMb.toFixed(1), quotaMb, pct, workspaceSlug },
        })
      }
    } catch (err) {
      console.error('checkStorageThreshold failed:', err.message)
    }
  })()

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
}
```

- [ ] **Step 2: Delete lines 463–673 (and the `// Email Notifications (Resend)` section header) from `worker/index.js`**

- [ ] **Step 3: Commit**

```bash
git add worker/src/notify.js worker/index.js
git commit -m "refactor(portal): extract notify.js from worker/index.js

Pure move — sendEmail, resolveRecipients, buildEmailHtml,
notifyWorkspaceEvent, checkStorageThreshold."
```

---

### Task 5: Extract `auth.js`

**Files:**
- Create: `portal-app/worker/src/auth.js`
- Modify: `portal-app/worker/index.js:83-427` (remove — moved out)

**Interfaces:**
- Consumes: `errorResponse` from `./cors.js`.
- Produces: `requireAuth(request, env)`, `requireRole(user, ...roles)`, `requireWorkspaceAccess(user, workspaceSlug)`, `hasWorkspaceWriteAccess(user, workspaceSlug)`. (`getJwks`, `verifyJwt`, `fetchClerkUser`, etc. are internal helpers — not exported, only used within this file.)

- [ ] **Step 1: Create the file**

Create `portal-app/worker/src/auth.js` by cutting lines 83–427 from `worker/index.js` verbatim (the JWT verification section through `hasWorkspaceWriteAccess`), adding one import line at the top and `export` only to the four functions listed above (the rest — `getJwks`, `base64urlDecode`, `decodeJwt`, `importJwk`, `verifyJwt`, `fetchClerkUser`, `jwksCache`, `JWKS_CACHE_TTL_MS`, `clerkUserCache`, `CLERK_CACHE_TTL_MS` — stay unexported module-internal):

```javascript
// worker/src/auth.js
// JWT verification (RS256 via Web Crypto), Clerk Backend API lookup, and the
// D1-authoritative requireAuth/RBAC middleware.

import { errorResponse } from './cors.js'

let jwksCache = null
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000

async function getJwks(env) {
  const now = Date.now()
  if (jwksCache && (now - jwksCache.fetchedAt) < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys
  }

  const frontendApi = env.CLERK_FRONTEND_API
  if (!frontendApi) {
    throw new Error('CLERK_FRONTEND_API environment variable is not configured')
  }

  const url = `${frontendApi}/.well-known/jwks.json`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  jwksCache = { keys: data.keys, fetchedAt: now }
  return data.keys
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeJwt(token) {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: expected 3 parts')
  }

  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])))
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
  const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64urlDecode(parts[2])

  return { header, payload, signatureInput, signature }
}

async function importJwk(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

async function verifyJwt(token, env) {
  const { header, payload, signatureInput, signature } = decodeJwt(token)

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`)
  }

  const keys = await getJwks(env)
  const matchingKey = keys.find((k) => k.kid === header.kid)
  if (!matchingKey) {
    jwksCache = null
    const freshKeys = await getJwks(env)
    const retryKey = freshKeys.find((k) => k.kid === header.kid)
    if (!retryKey) {
      throw new Error(`No matching JWKS key found for kid: ${header.kid}`)
    }
    const cryptoKey = await importJwk(retryKey)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signatureInput)
    if (!valid) throw new Error('JWT signature verification failed')
  } else {
    const cryptoKey = await importJwk(matchingKey)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signatureInput)
    if (!valid) throw new Error('JWT signature verification failed')
  }

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) {
    throw new Error('JWT has expired')
  }
  if (payload.nbf && payload.nbf > now + 60) {
    throw new Error('JWT is not yet valid')
  }

  return payload
}

const clerkUserCache = new Map()
const CLERK_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchClerkUser(clerkUserId, env) {
  const now = Date.now()
  const cached = clerkUserCache.get(clerkUserId)
  if (cached && (now - cached.cachedAt) < CLERK_CACHE_TTL_MS) {
    return cached
  }

  if (!env.CLERK_SECRET_KEY) {
    return null
  }

  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    })
    if (!response.ok) {
      console.error(`Clerk API error for ${clerkUserId}: ${response.status}`)
      return null
    }
    const data = await response.json()
    const publicMetadata = data.public_metadata || {}
    const result = {
      role: publicMetadata.role || 'client',
      workspaceSlugs: publicMetadata.workspace_slugs || [],
      email: data.email_addresses?.[0]?.email_address || null,
      username: data.username || null,
      cachedAt: now,
    }
    clerkUserCache.set(clerkUserId, result)
    return result
  } catch (err) {
    console.error('Clerk API fetch failed:', err.message)
    return null
  }
}

export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw errorResponse('Missing or invalid Authorization header', 401)
  }

  const token = authHeader.slice(7)
  if (!token) {
    throw errorResponse('Empty bearer token', 401)
  }

  let payload
  try {
    payload = await verifyJwt(token, env)
  } catch (err) {
    throw errorResponse(`Authentication failed: ${err.message}`, 401)
  }

  const clerkUserId = payload.sub

  const publicMetadata = payload.publicMetadata || payload.metadata?.publicMetadata || {}

  let dbUserId = null
  let role = null
  let workspaceSlugs = null
  let workspacePermissions = null

  const dbUser = await env.DB.prepare(
    'SELECT id, role, username, email, status FROM users WHERE clerk_id = ?',
  )
    .bind(clerkUserId)
    .first()

  if (dbUser) {
    if (dbUser.status === 'inactive') {
      throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
    }
    dbUserId = dbUser.id
    role = dbUser.role
    const wsResult = await env.DB.prepare(
      `SELECT w.slug, uw.permission FROM workspaces w
       INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
       WHERE uw.user_id = ?`,
    )
      .bind(dbUser.id)
      .all()
    workspaceSlugs = wsResult.results.map((r) => r.slug)
    workspacePermissions = {}
    for (const r of wsResult.results) {
      workspacePermissions[r.slug] = r.permission || 'read'
    }
  }

  if (!dbUserId) {
    const emailCandidates = [
      payload.email,
      payload.primaryEmail,
    ].filter(Boolean)

    if (emailCandidates.length === 0) {
      const clerkUser = await fetchClerkUser(clerkUserId, env)
      if (clerkUser) {
        if (clerkUser.email) emailCandidates.push(clerkUser.email)
      }
    }

    for (const email of emailCandidates) {
      const matched = await env.DB.prepare(
        'SELECT id, role, status FROM users WHERE LOWER(email) = LOWER(?)',
      )
        .bind(email)
        .first()
      if (matched) {
        if (matched.status === 'inactive') {
          throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
        }
        dbUserId = matched.id
        role = matched.role
        await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
          .bind(clerkUserId, matched.id).run()
        console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via email`)

        const wsResult = await env.DB.prepare(
          `SELECT w.slug, uw.permission FROM workspaces w
           INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
           WHERE uw.user_id = ?`,
        )
          .bind(matched.id)
          .all()
        workspaceSlugs = wsResult.results.map((r) => r.slug)
        workspacePermissions = {}
        for (const r of wsResult.results) {
          workspacePermissions[r.slug] = r.permission || 'read'
        }
        break
      }
    }

    if (!dbUserId) {
      const clerkUsername = publicMetadata.username || payload.username || null
      if (clerkUsername) {
        const matched = await env.DB.prepare(
          'SELECT id, role, status FROM users WHERE username = ?',
        ).bind(clerkUsername).first()
        if (matched) {
          if (matched.status === 'inactive') {
            throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
          }
          dbUserId = matched.id
          role = matched.role
          await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
            .bind(clerkUserId, matched.id).run()
          console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via username`)

          const wsResult = await env.DB.prepare(
            `SELECT w.slug, uw.permission FROM workspaces w
             INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
             WHERE uw.user_id = ?`,
          )
            .bind(matched.id)
            .all()
          workspaceSlugs = wsResult.results.map((r) => r.slug)
          workspacePermissions = {}
          for (const r of wsResult.results) {
            workspacePermissions[r.slug] = r.permission || 'read'
          }
        }
      }
    }

    if (!dbUserId) {
      role = publicMetadata.role || null
      workspaceSlugs = publicMetadata.workspace_slugs || null
    }
  }

  return {
    userId: clerkUserId,
    dbUserId: dbUserId,
    role: role || 'client',
    workspaceSlugs: workspaceSlugs || [],
    workspacePermissions: workspacePermissions || {},
    email: payload.email || null,
    claims: payload,
  }
}

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw errorResponse(
      `Forbidden: requires one of [${roles.join(', ')}], you have [${user.role}]`,
      403,
    )
  }
}

export function requireWorkspaceAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') {
    return
  }
  if (!user.workspaceSlugs.includes(workspaceSlug)) {
    throw errorResponse('Forbidden: you do not have access to this workspace', 403)
  }
}

export function hasWorkspaceWriteAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') return true
  const perm = (user.workspacePermissions || {})[workspaceSlug]
  return perm === 'write' || perm === 'admin'
}
```

- [ ] **Step 2: Delete lines 83–427 (and the two section headers `JWT Verification...` and `Clerk Backend API...` and `Auth & RBAC Middleware`) from `worker/index.js`**

- [ ] **Step 3: Commit**

```bash
git add worker/src/auth.js worker/index.js
git commit -m "refactor(portal): extract auth.js from worker/index.js

Pure move — JWT verification, Clerk Backend API lookup, requireAuth,
requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess. Imports
errorResponse from ./cors.js."
```

---

### Task 6: Extract the seven `routes/*.js` files

**Files:**
- Create: `portal-app/worker/src/routes/me.js`
- Create: `portal-app/worker/src/routes/workspaces.js`
- Create: `portal-app/worker/src/routes/files.js`
- Create: `portal-app/worker/src/routes/folders.js`
- Create: `portal-app/worker/src/routes/users.js`
- Create: `portal-app/worker/src/routes/admin.js`
- Create: `portal-app/worker/src/routes/briefs.js`
- Modify: `portal-app/worker/index.js` (remove everything moved — after this task, only `matchPath` and the `export default { fetch }` dispatch remain)

**Interfaces:**
- Consumes (all route files, as needed by the functions they contain): `jsonResponse`, `errorResponse` from `../cors.js`; `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess` from `../auth.js`; `logAudit`, `getClientIp` from `../audit.js`; `notifyWorkspaceEvent`, `checkStorageThreshold` from `../notify.js`.
- Produces: every `handle*` function listed in the Investigation Summary table above, one file per row, as named exports.

This is the biggest task — each function's **body is unchanged**, only its file, its imports, and the `export` keyword change. Do the seven files **in this order** (me → workspaces → files → folders → users → admin → briefs), since `router.js` in Task 7 will need all seven to exist first.

- [ ] **Step 1: `routes/me.js`** — move `handleHealth` (lines 702–711 of the *current* `index.js`, before any of Tasks 2–5's deletions shifted line numbers — **re-locate by function name, not by these original line numbers, since earlier tasks already changed the file**). Also extract the inline `/api/me` block into a new `handleMe` function:

```javascript
// worker/src/routes/me.js
import { jsonResponse } from '../cors.js'

export async function handleHealth(request, env) {
  return jsonResponse({
    status: 'healthy',
    service: 'wsl-portal-api',
    timestamp: new Date().toISOString(),
    d1: !!env.DB,
    r2: !!env.FILES,
    clerkApi: !!env.CLERK_SECRET_KEY,
  })
}

/** GET /api/me — the authenticated user's D1 role, workspaces, and permissions. */
export async function handleMe(request, env, user) {
  return jsonResponse({
    userId: user.dbUserId || user.userId,
    role: user.role,
    workspaceSlugs: user.workspaceSlugs,
    workspacePermissions: user.workspacePermissions,
    email: user.email,
  })
}
```

Delete `handleHealth` from `index.js`. Delete the inline `/api/me` `if` block from the router dispatch too — Task 7 replaces it with a call to `handleMe`.

- [ ] **Step 2: `routes/workspaces.js`** — move `handleListWorkspaces`, `handleGetWorkspace`, `handleCreateWorkspace`, `handleUpdateWorkspace`, `handleDeleteWorkspace`, `handleGetUserWorkspaces`, `handleUpdateUserWorkspaces` verbatim. Add imports at the top for whatever each function body references (per the closed list in this task's Interfaces section above — e.g. `handleGetWorkspace` calls `requireWorkspaceAccess`, `logAudit`, `getClientIp`; `handleCreateWorkspace`/`handleUpdateWorkspace`/`handleDeleteWorkspace` call `requireRole`; etc.). After writing the file, run:

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app/worker" && node --check src/routes/workspaces.js
```

Expected: no output (syntax valid). This only catches syntax errors, not missing imports — missing-import `ReferenceError`s surface later when `router.js` (Task 7) actually calls these functions and you run the smoke test (Task 8). If that happens, come back and add the missing named import from the correct sibling module — never invent a new shared file for it.

Delete these seven functions from `index.js`.

- [ ] **Step 3: `routes/files.js`** — move `ALLOWED_MIME_TYPES`, `VALID_CATEGORIES`, `MAX_FILE_SIZE`, `handleListFiles`, `handleUploadFile`, `handleReplaceFile`, `handleGetFileVersions`, `handleDeleteFile`, `handleDownloadFile`, `handleMoveFile` verbatim, with imports per the same process as Step 2. Run `node --check src/routes/files.js`. Delete from `index.js`.

- [ ] **Step 4: `routes/folders.js`** — move `validateFolderName`, `handleListFolderContents`, `handleCreateFolder`, `handleRenameFolder`, `handleDeleteFolder`, `handleMoveFolder` verbatim, with imports. Run `node --check src/routes/folders.js`. Delete from `index.js`.

- [ ] **Step 5: `routes/users.js`** — move `handleListUsers`, `handleCreateUser`, `handleChangeRole`, `handleDeactivateUser`, `handleActivateUser` verbatim, with imports. Run `node --check src/routes/users.js`. Delete from `index.js`.

- [ ] **Step 6: `routes/admin.js`** — move `DASHBOARD_PROJECTS_DATA`, `handleAuditLog`, `handleAdminAnalytics`, `handleDashboardProjects` verbatim, with imports. Run `node --check src/routes/admin.js`. Delete from `index.js`.

- [ ] **Step 7: `routes/briefs.js`** — move `verifyServiceKey`, `_parseBriefRow`, `handlePostBrief`, `handleListBriefs`, `handleGetLatestBrief`, `handleGetBrief` verbatim, with imports. Note `verifyServiceKey` checks `env.WSL_SERVICE_KEY` directly (no cross-file dependency) and `handlePostBrief` is called from the router **before** `requireAuth` runs (public-but-service-key-gated route) — keep that call signature (`handlePostBrief(request, env)`, no `user` param) intact. Run `node --check src/routes/briefs.js`. Delete from `index.js`.

- [ ] **Step 8: Verify `index.js` is down to just `matchPath` + the router dispatch**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app/worker" && wc -l index.js
```

Expected: roughly 210 lines left (the original `matchPath` function ~18 lines + the `export default { fetch }` dispatch block ~200 lines). If it's still close to 2,607, a step above was skipped.

- [ ] **Step 9: Commit**

```bash
git add worker/src/routes worker/index.js
git commit -m "refactor(portal): extract routes/{me,workspaces,files,folders,users,admin,briefs}.js

Pure move — every handle* function now lives in its own route module,
one file per resource. index.js retains only matchPath and the router
dispatch (finished in the next task)."
```

---

### Task 7: Build `router.js` and shrink `index.js` to a thin entry point

**Files:**
- Create: `portal-app/worker/src/router.js`
- Modify: `portal-app/worker/index.js` (becomes ~6 lines)

**Interfaces:**
- Consumes: `CORS_HEADERS`, `errorResponse` from `./cors.js`; `requireAuth` from `./auth.js`; `handleHealth`, `handleMe` from `./routes/me.js`; every other `handle*` from their respective `./routes/*.js` files.
- Produces: `export default { fetch(request, env, ctx) {...} }` — the exact same Worker entry contract Cloudflare expects.

- [ ] **Step 1: Create `router.js`**

Move `matchPath` (currently still in `index.js` after Task 6) and the entire `export default { fetch... }` block into `worker/src/router.js`, with one change: the inline `/api/me` handler block becomes a call to `handleMe(request, env, user)`.

```javascript
// worker/src/router.js
// Path matching + the top-level fetch dispatch. Every route handler is a
// pure function imported from ./routes/*; this file only decides which one
// to call for a given method+pathname.

import { CORS_HEADERS, errorResponse } from './cors.js'
import { requireAuth } from './auth.js'
import { handleHealth, handleMe } from './routes/me.js'
import {
  handleListWorkspaces,
  handleGetWorkspace,
  handleCreateWorkspace,
  handleUpdateWorkspace,
  handleDeleteWorkspace,
  handleGetUserWorkspaces,
  handleUpdateUserWorkspaces,
} from './routes/workspaces.js'
import {
  handleListFiles,
  handleUploadFile,
  handleReplaceFile,
  handleGetFileVersions,
  handleDeleteFile,
  handleDownloadFile,
  handleMoveFile,
} from './routes/files.js'
import {
  handleListFolderContents,
  handleCreateFolder,
  handleRenameFolder,
  handleDeleteFolder,
  handleMoveFolder,
} from './routes/folders.js'
import {
  handleListUsers,
  handleCreateUser,
  handleChangeRole,
  handleDeactivateUser,
  handleActivateUser,
} from './routes/users.js'
import {
  handleAuditLog,
  handleAdminAnalytics,
  handleDashboardProjects,
} from './routes/admin.js'
import {
  handlePostBrief,
  handleListBriefs,
  handleGetLatestBrief,
  handleGetBrief,
} from './routes/briefs.js'

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/')
  const pathParts = pathname.split('/')

  if (patternParts.length !== pathParts.length) {
    return null
  }

  const params = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i])
    } else if (patternParts[i] !== pathParts[i]) {
      return null
    }
  }
  return params
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return handleHealth(request, env)
      }

      if (pathname === '/api/briefs' && method === 'POST') {
        return handlePostBrief(request, env)
      }

      if (pathname.startsWith('/api/')) {
        const user = await requireAuth(request, env)

        if (pathname === '/api/me' && method === 'GET') {
          return handleMe(request, env, user)
        }

        if (pathname === '/api/workspaces' && method === 'GET') {
          return handleListWorkspaces(request, env, user)
        }

        let params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'GET') {
          return handleGetWorkspace(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/files', pathname)
        if (params && method === 'GET') {
          return handleListFiles(request, env, user, params)
        }
        if (params && method === 'POST') {
          return handleUploadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id', pathname)
        if (params && method === 'PUT') {
          return handleReplaceFile(request, env, user, params, ctx)
        }
        if (params && method === 'DELETE') {
          return handleDeleteFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/download', pathname)
        if (params && method === 'GET') {
          return handleDownloadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/versions', pathname)
        if (params && method === 'GET') {
          return handleGetFileVersions(request, env, user, params)
        }

        params = matchPath('/api/files/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }
        if (params && method === 'POST') {
          return handleCreateFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders/:folderId', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }

        params = matchPath('/api/folders/:id', pathname)
        if (params && method === 'PATCH') {
          return handleRenameFolder(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return handleDeleteFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/folders/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFolder(request, env, user, params, ctx)
        }

        if (pathname === '/api/users' && method === 'GET') {
          return handleListUsers(request, env, user)
        }

        if (pathname === '/api/users' && method === 'POST') {
          return handleCreateUser(request, env, user, ctx)
        }

        params = matchPath('/api/users/:id/role', pathname)
        if (params && method === 'PATCH') {
          return handleChangeRole(request, env, user, params)
        }

        params = matchPath('/api/users/:id/deactivate', pathname)
        if (params && method === 'POST') {
          return handleDeactivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/activate', pathname)
        if (params && method === 'POST') {
          return handleActivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/workspaces', pathname)
        if (params && method === 'GET') {
          return handleGetUserWorkspaces(request, env, user, params)
        }
        if (params && method === 'PATCH') {
          return handleUpdateUserWorkspaces(request, env, user, params)
        }

        if (pathname === '/api/workspaces' && method === 'POST') {
          return handleCreateWorkspace(request, env, user)
        }

        params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'PATCH') {
          return handleUpdateWorkspace(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return handleDeleteWorkspace(request, env, user, params)
        }

        if (pathname === '/api/audit-log' && method === 'GET') {
          return handleAuditLog(request, env, user)
        }

        if (pathname === '/api/admin/analytics' && method === 'GET') {
          return handleAdminAnalytics(request, env, user)
        }

        if (pathname === '/api/dashboard/projects' && method === 'GET') {
          return handleDashboardProjects(request, env, user)
        }

        if (pathname === '/api/briefs/latest' && method === 'GET') {
          return handleGetLatestBrief(request, env, user)
        }
        if (pathname === '/api/briefs' && method === 'GET') {
          return handleListBriefs(request, env, user)
        }
        const briefDateMatch = pathname.match(/^\/api\/briefs\/(\d{4}-\d{2}-\d{2})$/)
        if (briefDateMatch && method === 'GET') {
          return handleGetBrief(request, env, user, briefDateMatch[1])
        }

        return errorResponse('Not found', 404)
      }

      return errorResponse('Not found', 404)
    } catch (err) {
      if (err instanceof Response) {
        return err
      }

      console.error('Unhandled error:', err.message, err.stack)
      return errorResponse('Internal server error', 500)
    }
  },
}
```

- [ ] **Step 2: Shrink `index.js` to a thin entry point**

Replace the entire contents of `portal-app/worker/index.js` with:

```javascript
/**
 * WarSignalLabs Portal API Worker — entry point.
 * See worker/src/router.js for the route dispatch, worker/src/routes/*.js
 * for individual handlers, and worker/src/{cors,auth,audit,notify}.js for
 * shared helpers.
 *
 * Bindings (configured in wrangler.toml):
 *   - DB: D1 database (wsl-portal)
 *   - FILES: R2 bucket (wsl-portal-files)
 *   - CLERK_SECRET_KEY: secret (for Backend API user lookup)
 *   - CLERK_FRONTEND_API: var
 *   - RESEND_API_KEY: secret (for email notifications via Resend)
 *   - RESEND_FROM_EMAIL: var
 *   - RESEND_FROM_NAME: var
 *   - WSL_SERVICE_KEY: secret (GW-OS brief ingest)
 */

export { default } from './src/router.js'
```

- [ ] **Step 3: Verify wrangler still recognizes the entry point**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app/worker" && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry-run 2>&1 | tail -20
```

Expected: no errors; ends with a successful bundle summary (no deploy actually happens with `--dry-run`).

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/src/router.js
git commit -m "refactor(portal): finish worker modularization — router.js + thin index.js

index.js is now a 20-line entry point re-exporting the fetch handler
assembled in src/router.js. Worker split from 2,607 lines in one file
to 11 focused modules; no route logic changed."
```

---

### Task 8: Smoke-test script — verify byte-identical behavior, then deploy

**Files:**
- Create: `portal-app/worker/scripts/smoke-test.js`

**Interfaces:**
- Produces: a CLI script `node worker/scripts/smoke-test.js --base-url <url> --token <bearer-jwt> --out <file.json>` that hits every GET endpoint and writes `{ [method+path]: { status, bodyKeys } }` to `--out`.

- [ ] **Step 1: Write the smoke-test script**

Create `portal-app/worker/scripts/smoke-test.js`:

```javascript
#!/usr/bin/env node
// Hits every GET endpoint on the portal API and snapshots {status, bodyKeys}.
// Run once against the OLD deployed worker, then again against the NEW
// (refactored) worker after deploy, and diff the two JSON files — any
// difference means the refactor changed behavior.
//
// Usage:
//   node worker/scripts/smoke-test.js --base-url https://api.warsignallabs.net \
//     --token "$BEARER_JWT" --out /tmp/smoke-before.json
//
// The token is a real Clerk-issued JWT — copy the "Authorization: Bearer ..."
// header value from a signed-in browser session's Network tab (any request
// to api.warsignallabs.net). Tokens are short-lived; capture a fresh one for
// each run (before AND after) so both runs authenticate as the same user.

import { writeFileSync } from 'node:fs'

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    out[args[i].replace(/^--/, '')] = args[i + 1]
  }
  return out
}

const { 'base-url': baseUrl, token, out } = parseArgs()
if (!baseUrl || !token || !out) {
  console.error('Usage: node smoke-test.js --base-url <url> --token <jwt> --out <file.json>')
  process.exit(1)
}

// Every GET endpoint from worker/src/router.js. Params use real IDs/slugs
// that exist in production (see portal-app/CONTEXT.md D1 tables).
const ENDPOINTS = [
  { method: 'GET', path: '/api/health', auth: false },
  { method: 'GET', path: '/api/me', auth: true },
  { method: 'GET', path: '/api/workspaces', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs/files', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs/folders', auth: true },
  { method: 'GET', path: '/api/users', auth: true },
  { method: 'GET', path: '/api/audit-log', auth: true },
  { method: 'GET', path: '/api/admin/analytics', auth: true },
  { method: 'GET', path: '/api/dashboard/projects', auth: true },
  { method: 'GET', path: '/api/briefs/latest', auth: true },
  { method: 'GET', path: '/api/briefs', auth: true },
]

function sortedKeys(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') return []
  if (Array.isArray(obj)) {
    return obj.length > 0 ? sortedKeys(obj[0], `${prefix}[]`) : [`${prefix}[]`]
  }
  return Object.keys(obj).sort().flatMap((k) =>
    [`${prefix}${prefix ? '.' : ''}${k}`, ...sortedKeys(obj[k], `${prefix}${prefix ? '.' : ''}${k}`)]
  )
}

async function main() {
  const results = {}
  for (const ep of ENDPOINTS) {
    const key = `${ep.method} ${ep.path}`
    try {
      const response = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: ep.auth ? { Authorization: `Bearer ${token}` } : {},
      })
      const status = response.status
      let bodyKeys = []
      try {
        const body = await response.json()
        bodyKeys = sortedKeys(body)
      } catch {
        bodyKeys = ['<non-JSON body>']
      }
      results[key] = { status, bodyKeys }
      console.log(`${status} ${key}`)
    } catch (err) {
      results[key] = { status: 'ERROR', error: err.message }
      console.log(`ERROR ${key}: ${err.message}`)
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2))
  console.log(`\nWrote ${out}`)
}

main()
```

- [ ] **Step 2: Run the smoke test against the CURRENT production worker (before deploying the refactor)**

Get a fresh bearer token: sign in to `https://portal.warsignallabs.net` in a browser, open DevTools → Network, find any request to `api.warsignallabs.net`, copy its `Authorization: Bearer ...` header value (the token after `Bearer `).

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
node worker/scripts/smoke-test.js --base-url https://api.warsignallabs.net --token "PASTE_TOKEN_HERE" --out /tmp/smoke-before.json
```

Expected: every line prints a `200` (or `204`) status. If anything errors here, stop — that's a pre-existing production issue unrelated to this refactor; investigate separately before proceeding.

- [ ] **Step 3: Deploy the refactored worker**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app/worker"
npx wrangler deploy
```

- [ ] **Step 4: Run the smoke test again against the now-refactored production worker**

Capture a fresh token the same way as Step 2 (tokens expire quickly).

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
node worker/scripts/smoke-test.js --base-url https://api.warsignallabs.net --token "PASTE_FRESH_TOKEN_HERE" --out /tmp/smoke-after.json
```

- [ ] **Step 5: Diff the two snapshots**

```bash
diff /tmp/smoke-before.json /tmp/smoke-after.json
```

Expected: **no output** (identical files) — confirms the refactor changed nothing observable. If there's a diff, find which endpoint changed, go back to its route file in Task 6, and check for a transcription error against the original `git show HEAD~9:worker/index.js` (or further back — however many commits ago Task 2 started) for that function's original body.

- [ ] **Step 6: Commit the smoke-test script (results are not committed — they're throwaway verification artifacts)**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site"
git add portal-app/worker/scripts/smoke-test.js
git commit -m "test(portal): add smoke-test script for the worker refactor

Hits every GET endpoint, snapshots {status, bodyKeys}. Confirmed
identical before/after the worker/index.js modularization (Tasks 2-7)."
```

---

### Task 9: Executive retheme

**Files:**
- Create: `portal-app/src/themes/executive.css`
- Modify: `portal-app/src/main.jsx:6` (swap theme import)
- Modify: `portal-app/src/themes/base.css:6` (swap Google Fonts import)
- Modify: `portal-app/src/layouts/PortalLayout.jsx:72` (kill `[ MENU ]`/`[ CLOSE ]`)
- Modify: `portal-app/src/pages/AdminWorkspaces.jsx:15,27,87` (swap neon preset colors)
- Modify: every file listed in "kill-list hits" above with a `// Kicker` string (7 files)
- Delete: `portal-app/src/pages/Dashboard.jsx` (confirmed dead duplicate of `Home.jsx`)
- Modify: `portal-app/src/themes/dark-professional.css` → delete this file once `executive.css` replaces it

**Interfaces:**
- Produces: the same CSS custom-property names as `dark-professional.css` (`--bg-primary`, `--bg-surface`, `--bg-elevated`, `--bg-hover`, `--bg-active`, `--text-primary`, `--text-secondary`, `--text-muted`, `--text-inverse`, `--accent`, `--accent-hover`, `--accent-muted`, `--accent-secondary`, `--border`, `--border-strong`, `--border-accent`, `--success`, `--warning`, `--error`, `--info`, `--font-body`, `--font-heading`, `--font-mono`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--sidebar-width`, `--topnav-height`) with new executive-identity values — every consumer (`base.css`, page CSS files) keeps working unmodified since it's the same variable *names*, just new values.

- [ ] **Step 1: Create `executive.css`**

Create `portal-app/src/themes/executive.css`, deriving values from `PORTAL_OVERHAUL_PLAN.md` §3.3's token table (ground `#0E1726`, surface `#141F31`/elevated `#1A2740`, accent steel-blue `#6F8FB8`, primary CTA gold `#C9A557`, success muted-green `#4C9A6B`; warning/error keep hue, desaturated ~20% from the old `#ffaa00`/`#ff4d4d` → `#E6A51A`/`#ED5F5F`):

```css
/* ============================================
   THEME: Executive
   Description: Matches the marketing site's post-2026-05-05 identity —
   dark navy ground, single steel-blue accent, gold for primary CTAs only.
   Replaces the cyberpunk "Dark Professional" theme (see git history for
   the retired file: src/themes/dark-professional.css).
   ============================================ */

:root {
  /* Backgrounds */
  --bg-primary: #0E1726;
  --bg-surface: #141F31;
  --bg-elevated: #1A2740;
  --bg-hover: rgba(111, 143, 184, 0.06);
  --bg-active: rgba(111, 143, 184, 0.1);

  /* Text */
  --text-primary: #E8EDF5;
  --text-secondary: #8390A2;
  --text-muted: #5A6A7A;
  --text-inverse: #0E1726;

  /* Accent */
  --accent: #6F8FB8;
  --accent-hover: #85A2C6;
  --accent-muted: rgba(111, 143, 184, 0.15);
  --accent-secondary: #C9A557;

  /* Primary CTA (buttons only — see base.css .btn--primary) */
  --cta-primary: #C9A557;
  --cta-primary-hover: #E8C66B;

  /* Borders */
  --border: rgba(111, 143, 184, 0.12);
  --border-strong: rgba(111, 143, 184, 0.25);
  --border-accent: rgba(111, 143, 184, 0.4);

  /* Status */
  --success: #4C9A6B;
  --warning: #E6A51A;
  --error: #ED5F5F;
  --info: #6F8FB8;

  /* Typography */
  --font-body: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-heading: 'IBM Plex Serif', Georgia, 'Times New Roman', serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Spacing */
  --radius-sm: 3px;
  --radius-md: 4px;
  --radius-lg: 8px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);

  /* Sidebar */
  --sidebar-width: 220px;
  --topnav-height: 52px;
}
```

Note: `base.css`'s `.btn--primary` currently uses `var(--accent)` for its background — per the plan's "gold for primary CTAs only" rule, Step 4 below repoints `.btn--primary` specifically to `var(--cta-primary)` while everything else (links, focus rings, active nav) keeps using `var(--accent)` (steel-blue). `--accent-secondary` is kept for any component that referenced it (workspace card variety, badges) but is no longer "neon pink" — it's now gold, doubling as a secondary accent.

- [ ] **Step 2: Delete the old theme file**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
git rm src/themes/dark-professional.css
```

- [ ] **Step 3: Swap the import in `main.jsx`**

In `portal-app/src/main.jsx`, change:

```javascript
import './themes/dark-professional.css'
```

to:

```javascript
import './themes/executive.css'
```

- [ ] **Step 4: Repoint `.btn--primary` to the gold CTA color**

In `portal-app/src/themes/base.css`, find:

```css
.btn--primary {
  background: var(--accent);
  color: var(--text-inverse);
  border-color: var(--accent);
}

.btn--primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
```

Replace with:

```css
.btn--primary {
  background: var(--cta-primary);
  color: var(--text-inverse);
  border-color: var(--cta-primary);
}

.btn--primary:hover {
  background: var(--cta-primary-hover);
  border-color: var(--cta-primary-hover);
}
```

- [ ] **Step 5: Swap the Google Fonts import**

In `portal-app/src/themes/base.css`, change line 6 from:

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Inter:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap');
```

to:

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
```

- [ ] **Step 6: Delete the dead duplicate page**

```bash
git rm src/pages/Dashboard.jsx
```

(`src/pages/Dashboard.css` stays — `Home.jsx` still imports it.)

- [ ] **Step 7: Replace `[ MENU ]` / `[ CLOSE ]` with a plain label**

In `portal-app/src/layouts/PortalLayout.jsx`, change line 72 from:

```javascript
              {sidebarOpen ? '[ CLOSE ]' : '[ MENU ]'}
```

to:

```javascript
              {sidebarOpen ? 'Close' : 'Menu'}
```

- [ ] **Step 8: Fix the neon preset colors in `AdminWorkspaces.jsx`**

In `portal-app/src/pages/AdminWorkspaces.jsx`, change line 15 from:

```javascript
const PRESET_COLORS = ['#00c8d4', '#39ff14', '#ffaa00', '#ff6b9d', '#9d4edd', '#4cc9f0', '#f77f00']
```

to:

```javascript
const PRESET_COLORS = ['#6F8FB8', '#4C9A6B', '#E6A51A', '#C9A557', '#9D7FB8', '#4CA3C9', '#D97757']
```

Change the two default-color occurrences on lines 27 and 87 from `color: '#00c8d4'` to `color: '#6F8FB8'`.

- [ ] **Step 9: Replace the `// `-prefixed kickers with plain small-caps labels**

The `.label` class in `base.css` already renders as `font-mono`, small, uppercase, letter-spaced — the `// ` prefix was purely a stylistic cyberpunk affectation on top of that, not required for the visual hierarchy to read as a label. Remove the `// ` prefix (and in `WorkspaceDetail.jsx`'s multi-line case, whatever text follows on the same logical label) in each of these locations, keeping the rest of the text identical:

- `src/pages/Home.jsx:80` and `:95`: `// Dashboard` → `Dashboard`
- `src/pages/Settings.jsx:7`: `// Settings` → `Settings`
- `src/pages/AdminUsers.jsx:181`: `// Admin` → `Admin`
- `src/pages/AdminWorkspaces.jsx:128`: `// Admin` → `Admin`
- `src/pages/AdminAuditLog.jsx:70`: `// Admin` → `Admin`
- `src/pages/WorkspaceDetail.jsx:368`: `// Workspace` → `Workspace`
- `src/layouts/DashboardLayout.jsx:26`: `// Operations Dashboard` → `Operations Dashboard`

- [ ] **Step 10: Verify the kill-list is clean**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
grep -rn '\[ MENU \]\|\[ CLOSE \]\|Share Tech Mono\|#39ff14\|#00c8d4' src --include="*.jsx" --include="*.css" -i
```

Expected: **no output**.

- [ ] **Step 11: Visual check — build and screenshot every page**

```bash
npm run build && npm run dev
```

Open `http://localhost:5173` and click through: Home, a workspace detail page, Admin Users, Admin Workspaces, Admin Audit Log, Settings, the ops Dashboard (Projects + Briefs tabs). Confirm: navy background, steel-blue links/focus states, gold primary buttons, no neon cyan/green/pink anywhere, no `[ MENU ]`/`// ` text, IBM Plex fonts loading (check DevTools → Network → Fonts).

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(portal): executive retheme — replace cyberpunk identity

Matches the marketing site's post-2026-05-05 visual identity: navy
ground, steel-blue accent, gold primary CTAs, IBM Plex typography.
Kill-list grep clean. Deleted dead Dashboard.jsx duplicate and the
retired dark-professional.css."
```

---

### Task 10: Hygiene — version badge + Vitest + first auth test

**Files:**
- Modify: `portal-app/package.json` (version bump, add vitest + test script)
- Modify: `portal-app/src/layouts/PortalLayout.jsx` (version badge reads from package.json)
- Create: `portal-app/vitest.config.js`
- Create: `portal-app/worker/src/auth.test.js`

**Interfaces:**
- Produces: `npm test` (runs Vitest once, no watch).

- [ ] **Step 1: Bump the version and add Vitest**

In `portal-app/package.json`, change `"version": "0.0.0"` to `"version": "0.3.0"`, and add to `"devDependencies"`:

```json
    "vitest": "^3.0.0"
```

Then install:

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
npm install
```

- [ ] **Step 2: Add the test script**

In `portal-app/package.json`, add to `"scripts"`:

```json
    "test": "vitest run"
```

- [ ] **Step 3: Create the Vitest config**

Create `portal-app/vitest.config.js`:

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['worker/src/**/*.test.js'],
  },
})
```

- [ ] **Step 4: Write the failing test for the permission helpers**

Create `portal-app/worker/src/auth.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess } from './auth.js'

function makeUser(overrides = {}) {
  return {
    userId: 'clerk_123',
    dbUserId: 'usr-999',
    role: 'client',
    workspaceSlugs: [],
    workspacePermissions: {},
    email: 'test@example.com',
    ...overrides,
  }
}

describe('requireRole', () => {
  it('allows a user whose role is in the allowed list', () => {
    const user = makeUser({ role: 'admin' })
    expect(() => requireRole(user, 'admin', 'owner')).not.toThrow()
  })

  it('throws a 403 Response for a user whose role is not in the allowed list', async () => {
    const user = makeUser({ role: 'client' })
    let thrown
    try {
      requireRole(user, 'admin', 'owner')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
    const body = await thrown.json()
    expect(body.error).toContain('Forbidden')
  })
})

describe('requireWorkspaceAccess', () => {
  it('allows admin regardless of workspaceSlugs', () => {
    const user = makeUser({ role: 'admin', workspaceSlugs: [] })
    expect(() => requireWorkspaceAccess(user, 'any-workspace')).not.toThrow()
  })

  it('allows a client whose workspaceSlugs includes the target', () => {
    const user = makeUser({ role: 'client', workspaceSlugs: ['blueprint-advisory'] })
    expect(() => requireWorkspaceAccess(user, 'blueprint-advisory')).not.toThrow()
  })

  it('throws a 403 Response for a client without access to the workspace', async () => {
    const user = makeUser({ role: 'client', workspaceSlugs: ['warsignallabs'] })
    let thrown
    try {
      requireWorkspaceAccess(user, 'blueprint-advisory')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
  })
})

describe('hasWorkspaceWriteAccess', () => {
  it('returns true for admin regardless of workspacePermissions', () => {
    const user = makeUser({ role: 'admin', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'any-workspace')).toBe(true)
  })

  it('returns true for a client with write permission on the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { 'blueprint-advisory': 'write' } })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(true)
  })

  it('returns false for a client with only read permission on the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { 'blueprint-advisory': 'read' } })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(false)
  })

  it('returns false for a client with no permission entry for the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(false)
  })
})
```

- [ ] **Step 5: Run it and confirm it passes** (this test targets code that already exists from Task 5 — no implementation step needed, just verify)

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
npm test
```

Expected: `9 passed` (or similar — one suite per `describe`, 9 total `it` blocks), 0 failed.

- [ ] **Step 6: Wire the version badge to `package.json`**

In `portal-app/src/layouts/PortalLayout.jsx`, add an import at the top:

```javascript
import pkg from '../../package.json'
```

Then change line 76 from:

```javascript
            <span className="topnav__version mono">v0.2.0</span>
```

to:

```javascript
            <span className="topnav__version mono">v{pkg.version}</span>
```

- [ ] **Step 7: Verify the build still works with the JSON import**

```bash
npm run build
```

Expected: builds cleanly, `dist/assets/*.js` contains `"0.3.0"` (Vite inlines JSON imports at build time — confirm with `grep -o '0\.3\.0' dist/assets/index-*.js | head -1`).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.js worker/src/auth.test.js src/layouts/PortalLayout.jsx
git commit -m "chore(portal): version badge from package.json, Vitest + first auth tests

Bump to 0.3.0. Version badge in the topnav now reads from package.json
instead of a hardcoded string. First Vitest suite covers the RBAC
permission helpers (requireRole, requireWorkspaceAccess,
hasWorkspaceWriteAccess) extracted in Task 5."
```

---

### Task 11: Full-flow acceptance check + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full existing-flows acceptance checklist from `PORTAL_OVERHAUL_PLAN.md` Phase 1**

Against the live production portal (`https://portal.warsignallabs.net`), signed in as yourself:
- [ ] Sign in works (Google)
- [ ] Home dashboard loads with all workspaces visible
- [ ] Open a workspace, browse folders, view a file
- [ ] Upload a file, replace a file, move a file
- [ ] Admin → Users page loads and lists users
- [ ] Admin → Workspaces page loads
- [ ] Admin → Audit Log page loads
- [ ] Settings page loads
- [ ] Ops Dashboard → Projects tab loads
- [ ] Ops Dashboard → Briefs tab loads

- [ ] **Step 2: Confirm the version badge and theme**

Confirm the topnav shows `v0.3.0` and the whole UI matches the executive palette (navy/steel-blue/gold, no neon).

- [ ] **Step 3: Deploy the frontend** (the worker was already deployed in Task 8)

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site/portal-app"
npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true
```

- [ ] **Step 4: Re-run Step 1's checklist against the freshly deployed frontend** to confirm the deploy didn't regress anything.

- [ ] **Step 5: Update `handoff.yaml`**

Add a `session_<today's date>` entry to `portal-app/handoff.yaml` summarizing: Worker split into 11 modules (smoke-tested identical), D1 migration scaffold added, executive retheme shipped, version bumped to 0.3.0, first Vitest suite added.

- [ ] **Step 6: Push and open the PR**

```bash
cd "/Users/russmeadows/Dev/1 - WarSignalLabs/1 - Apps/2 - WebApps/warsignallabs-site"
git add portal-app/handoff.yaml
git commit -m "docs(portal): update handoff.yaml for Phase 1 completion"
git push -u origin feat/portal-phase1-foundation
gh pr create --title "feat(portal): Phase 1 — Worker modularization, D1 migrations, executive retheme" --body "$(cat <<'EOF'
Phase 1 of portal-app/PORTAL_OVERHAUL_PLAN.md. No user-visible behavior
change except the retheme.

## Changes
- worker/index.js (2,607 lines) split into 11 focused ES modules under
  worker/src/ — cors, auth, audit, notify, router, and 7 route files.
  Every function body is an unchanged move; verified byte-identical via
  a before/after smoke-test script against every GET endpoint.
- D1 migration scaffold: schema_migrations table + npm run migrate,
  idempotent baseline migration documenting the current schema.
- Executive retheme: navy/steel-blue/gold identity matching the
  marketing site, IBM Plex fonts, kill-list grep clean. Deleted the
  dead Dashboard.jsx duplicate and the retired dark-professional.css.
- Hygiene: version badge now reads from package.json (bumped to
  0.3.0), first Vitest suite (RBAC permission helpers).

## Explicitly deferred (flagged, not silently dropped)
- Shared frontend components (Modal/Toast/EmptyState/ConfirmDialog)
  extraction — investigation found this touches at least 4 files with
  real design-judgment calls; kept out of this PR to stay reviewable.

## Verification
- Smoke-test diff (before/after worker deploy): clean, zero differences
- Full manual flow checklist: sign-in, browse, upload/replace/move,
  all admin pages, ops dashboard — all pass
- Kill-list grep: zero hits
- npm test: 9/9 passing
EOF
)"
```

---

## Self-Review

**Spec coverage:** `PORTAL_OVERHAUL_PLAN.md` Phase 1 lists 4 items — (1) Modularize the Worker → Tasks 2–8; (2) D1 migration scaffold → Task 1; (3) Retheme → Task 9; (4) Hygiene (version badge, shared components, Vitest) → Task 10, with shared-component extraction explicitly deferred and flagged in the Global Constraints section and the PR body. Phase 1's acceptance criteria ("all existing flows work... kill-list grep = 0; npm run migrate idempotent; new theme live") are covered by Task 11's checklist, Task 9 Step 10, Task 1 Step 6, and Task 9 Step 11 respectively.

**Placeholder scan:** No "TBD"/"add appropriate"/"similar to Task N" patterns — every step has literal file paths, literal code, or literal shell commands with expected output. The one place I deliberately used a "move verbatim, add imports as errors surface" instruction (Task 6) instead of re-embedding ~1,800 lines of unchanged business logic is called out explicitly in the Global Constraints and justified in the Investigation Summary — this is a closed, bounded instruction (only 4 possible import sources), not an open-ended "handle it somehow."

**Type/name consistency:** Verified `handleMe` (introduced in Task 6 Step 1) is called correctly in Task 7's `router.js` with signature `(request, env, user)` matching its definition. Verified every function name in Task 7's import block matches the Investigation Summary table's per-file export lists. Verified `worker/src/auth.test.js` imports exactly the four functions Task 5 exports from `auth.js` (not the internal unexported helpers).

---

Plan complete and saved to `docs/superpowers/plans/2026-07-17-portal-phase1-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
