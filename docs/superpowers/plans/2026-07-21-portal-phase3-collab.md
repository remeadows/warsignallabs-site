# Portal Phase 3 — Comments, Activity, Notification Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship workspace discussions + per-file comments, a workspace activity feed, and an in-app notification center (topnav bell, inbox, per-user email preference) — v0.5.0.

**Architecture:** One new migration adds `comments`, `notification_inbox`, `users.email_pref`, and `audit_log.workspace_id`. Pure, unit-testable helpers land in `worker/src/auth.js` (mention parsing, email-pref × event-type filter, comment edit/delete authorization) mirroring the Phase 2 pattern (`hasWorkspaceAdminPermission`, `memberChangeViolation`). A new `worker/src/routes/comments.js` carries comment CRUD; notifications (inbox list/mark-read/preferences) and activity land as small additions to existing route modules (see File Structure). `worker/src/notify.js`'s `notifyWorkspaceEvent` is restructured to always write an inbox row per recipient and separately gate the email leg on that recipient's `email_pref`; a second, narrower recipient-resolution path handles `comment.mention` (parsed `@username` matches only, not "all workspace members"). Frontend adds a shared `CommentThread` component mounted in two places (Discussion tab, file comment side panel), an Activity tab, and a topnav bell — all inside the existing `WorkspaceDetail.jsx` / `PortalLayout.jsx` shells, following Phase 2's tab-and-modal conventions.

**Tech Stack:** Cloudflare Workers (ES modules), D1 (SQLite), Vitest, React 19 + react-router, Clerk JWT auth, Resend email.

**Spec:** `docs/superpowers/specs/2026-07-19-phase3-comments-activity-notifications-design.md` (approved 2026-07-19). Parent: `portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2.4/§3.5, Phase 3 execution section (§4).

## Global Constraints

- **Rollout ordering (spec §"Rollout ordering"):** unlike Phase 2, there is no narrow-before-widen sequencing constraint — every schema change in this phase is additive (new tables, `ADD COLUMN`). Migration first, then Worker deploy, then frontend deploy. No role-promotion-style step.
- **Filename correction:** the spec's own SQL header says `003_comments_notifications.sql`, written when the 2026-07-17 sketch predated Phase 2's migrations. Phase 2 already consumed `002`–`006` (see Current-state facts). **The actual file this plan creates is `worker/migrations/007_comments_notifications.sql`.** Content is otherwise verbatim from the spec.
- **Ceilings (verbatim from spec §2):**
  - Comments — read: any workspace member. Create: `wsWrite` (write or admin permission, or global admin). Edit: author only, and only while `deleted_at IS NULL` (editing an already-deleted comment is a 404, not a 403). Delete: author, `wsAdmin`, or global admin — always soft delete, never a hard `DELETE FROM comments`.
  - Replies are exactly one level deep, enforced by **rejecting** a reply-to-a-reply (400 `"Cannot reply to a reply"`), never by silent re-parenting.
  - Mentions are parsed against *that workspace's* member usernames only; a match that isn't a member is silently ignored (not an error, no cross-workspace leakage).
  - A denied comment edit writes a `comment.edit.denied` audit row, following the Phase 2 `member.*.denied` pattern.
- **`logAudit` signature (spec §2):** `details.workspaceId` becomes an optional field on the existing `details` object — NOT a new positional parameter. A call site that omits it leaves the column `NULL`. This is backward compatible; only call sites that already have a `workspace.id`/`file.workspace_id` in scope get updated (Task 3).
- **Inbox vs. email are independently gated (spec §4):** the inbox row is written unconditionally for every resolved recipient. The email leg is filtered by `email_pref`: `all` → every event type; `mentions` → only `comment.mention`; `none` → nothing. This filter applies ONLY to the email leg, never to the inbox row.
- **`comment.mention` recipients are resolved separately** from the general "admins + workspace members" list Phase 1/2 already use — they come from parsed `@username` matches only.
- **Comment body:** plain text only, no markdown. Line breaks preserved client-side; `@mentions` highlighted client-side. No new escaping surface — same `escapeHtml` pattern already used in `notify.js` covers any comment text that flows into an email body.
- All commands run from `portal-app/` inside the working checkout unless stated otherwise. All `wrangler d1 execute` targets `--remote` database `wsl-portal` (id `9b47800b-5435-4e2c-890b-e38d2eea3f6a`, binding `DB`) — there is no local/staging D1.
- Deploy commands: Worker `cd portal-app/worker && npx wrangler deploy`; Frontend `cd portal-app && npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true`. **The frontend build requires `portal-app/.env` to exist in the checkout being built** (gitignored — a fresh worktree does NOT inherit it; copy it from the main checkout first).
- Version ends at `0.5.0` (`portal-app/package.json`; topnav badge picks it up automatically).
- Branch: `feat/portal-phase3-collab` off `main` (already exists locally, rebased onto `main` @ `aab9a0f` as of 2026-07-21 — just the design-spec doc commit, no code yet). Commit after every task.
- Test command: `npm test` (Vitest, `worker/src/**/*.test.js`, node env). New pure functions (mention parsing, email-pref filter, comment authz) must be unit-tested without live tokens or a live D1 — same discipline as `auth.test.js`.

## Current-state facts the tasks rely on (verified 2026-07-21 against `main` @ `aab9a0f`)

- **Migrations present:** `000_baseline.sql` … `006_invitation_indexes.sql`. Next filename is `007_comments_notifications.sql`.
- **`worker/src/audit.js`** exports `logAudit(env, userId, action, details = {})`, which `INSERT`s into `audit_log(id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)` — **no `workspace_id` column bound today**, even though many call sites' `details` already carry `workspaceSlug` (a slug, not the FK-able `workspace.id`). Also exports `getClientIp(request)`.
- **~28 `logAudit` call sites** across `auth.js` (1, no workspace), `routes/users.js` (6, all global — no workspace), `routes/workspaces.js` (5), `routes/files.js` (6), `routes/folders.js` (4), `routes/members.js` (6). `routes/briefs.js` has one more (`gw-os-service` pipeline log — unrelated domain, not touched).
  - **Already have a real `workspace.id` (or `file.workspace_id`/`folder.workspace_id`) in scope, need `workspaceId` added to `details`:** `workspaces.js` `handleGetWorkspace`(workspace.view)/`handleUpdateWorkspace`(workspace.update); `files.js` all 6 call sites; `folders.js` all 4 call sites; `members.js` all 6 call sites (via `workspace.id` from `getWorkspaceBySlug`, or `invitation.workspace_id`).
  - **Correctly stay global / `NULL`** (spec's own list): `users.js` (`user.create`, `user.role.change[.denied]`, `user.deactivate[.denied]`, `user.activate`), `workspaces.js` `handleCreateWorkspace`(workspace.create)/`handleDeleteWorkspace`(workspace.delete)/`handleUpdateUserWorkspaces`(user.workspaces.update).
  - **Ambiguous, flagged for Russ (spec is silent):** `workspaces.js` `handleGetWorkspace` fires `workspace.view` on every single page load of the workspace detail view. Populating `workspace_id` here means the Activity tab's `audit_log` query would show a "viewed" row every time anyone opens the page — likely noisy. **Decision made in Task 3: `workspace.view` is excluded from the Activity feed by filtering `action != 'workspace.view'` in the activity query (Task 7), not by leaving `workspace_id` NULL** — the column is still populated (consistent, no special-cased call site), the noise is filtered at read time where the decision is visible and easy to revisit.
- **`worker/src/notify.js`** current exports: `sendEmail`, `resolveRecipients(env, workspaceId)` (returns `{admins, workspaceMembers}`, `SELECT id, email` only — no `email_pref`), `escapeHtml`, `buildEmailHtml(title, bodyLines)` (bodyLines must already be pre-escaped by the caller — see the `html` tag pattern each route file uses today), `notifyWorkspaceEvent(env, ctx, {eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata})`, `checkStorageThreshold`. The `notifications` table (Phase 1, Resend send-log) is untouched by this phase — `notification_inbox` (Task 1) is new and separate, per spec.
- **`worker/src/auth.js`** exports (tail of file, ~line 308 on): `requireRole`, `requireWorkspaceAccess`, `hasWorkspaceWriteAccess`, `hasWorkspaceAdminPermission`, `memberChangeViolation`. `requireAuth`'s returned user object does NOT include `email_pref` — Task 6 adds a dedicated query in `handleMe` rather than touching the three `SELECT`s inside `requireAuth`'s hot path.
- **`worker/src/router.js`**: imports one block per route file, dispatches via `matchPath(pattern, pathname)` inside a single `try` in `fetch()`. The members/invitations block (lines ~172–196) is the most recent addition and the model for wiring in new blocks.
- **`worker/src/routes/members.js`** — `handleCreateInvitation` already uses `env.DB.batch([...])` for atomic multi-statement writes (Task 5's comment+mention-parse path follows the same shape where needed).
- **Frontend:** `src/pages/WorkspaceDetail.jsx` is one large component (no separate `FolderBrowser`); its tab bar (`workspace__tabs`, ~line 379) currently renders Files / Members / (Settings if `wsAdmin`) as sibling `<button>`s toggling `activeTab` state; each tab body is a plain `{activeTab === 'x' && <Component/>}`. The file-row `<td className="file-actions">` (~line 533) is where a new "Comments" trigger belongs, alongside Download/Replace/Move/Delete. `src/layouts/PortalLayout.jsx`'s `.topnav__user` div (~line 93) holds only username + Clerk `UserButton` today — the bell mounts here. `src/contexts/PortalAuth.jsx` exposes `{d1User, role, isAdmin, isOwner, isPrivileged, authLoading, workspaces}`; `d1User` is the raw `/api/me` payload. `src/api/client.js` (194 lines) is a single `useMemo` object of `apiFetch`-backed methods; Members/invitations section is the most recent addition and the model to extend. `src/components/workspace/MembersTab.jsx` / `WorkspaceSettingsTab.jsx` are the component convention to match (local `useState`, `useApiClient()`, `usePortalAuth()`).
- **`worker/src/routes/me.js`**: `handleMe(request, env, user)` returns `{userId, role, workspaceSlugs, workspacePermissions, email}` — no DB query of its own today (everything comes from the already-loaded `user` object). Task 6 adds one extra `env.DB` query here for `email_pref`.
- Production users unchanged since Phase 2: `usr-001` armeadows (admin), `usr-003` rmeadows (admin), `usr-004` cdepalma (owner) — see `portal-app/handoff.yaml` §Clerk migration for the historical mapping (unrelated initiative, do not confuse with this plan).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `worker/migrations/007_comments_notifications.sql` | Create | `comments`, `notification_inbox` tables; `users.email_pref`, `audit_log.workspace_id` columns |
| `worker/src/audit.js` | Modify | `logAudit` binds `details.workspaceId` into the new column |
| `worker/src/auth.js` | Modify | `parseMentions`, `shouldEmailForPref`, `isCommentEditableBy`, `commentDeleteViolation` |
| `worker/src/auth.test.js` | Modify | Unit tests for the four new pure helpers |
| `worker/src/routes/files.js`, `folders.js`, `members.js`, `workspaces.js` | Modify | Add `workspaceId:` to existing `logAudit` call sites (mechanical) |
| `worker/src/notify.js` | Modify | `resolveRecipients` selects `email_pref`; `notifyWorkspaceEvent` writes inbox rows + gates email by pref; new `resolveMentionRecipients` for the narrower mention path |
| `worker/src/routes/comments.js` | Create | Comment CRUD + mention-triggered notifications |
| `worker/src/routes/me.js` | Modify | `handleMe` includes `email_pref`; new `handleUpdatePreferences` |
| `worker/src/routes/workspaces.js` | Modify | New `handleGetActivity` |
| `worker/src/router.js` | Modify | Routes for comments, notifications, preferences, activity |
| `src/api/client.js` | Modify | Comment/notification/activity/preference methods |
| `src/components/CommentThread.jsx` | Create | Shared thread + composer (Discussion tab + file panel) |
| `src/components/NotificationBell.jsx` | Create | Topnav bell, dropdown, unread poll |
| `src/components/workspace/ActivityTab.jsx` | Create | Paginated `audit_log` list |
| `src/components/FileCommentPanel.jsx` | Create | Slide-over wrapping `CommentThread` for `entity_type='file'` |
| `src/pages/WorkspaceDetail.jsx` | Modify | Discussion + Activity tabs; "Comments" file-row action |
| `src/layouts/PortalLayout.jsx` | Modify | Mount `NotificationBell` in `.topnav__user` |
| `src/components/workspace/WorkspaceSettingsTab.jsx` | Modify | Email-preference radio group |
| `package.json` | Modify | 0.4.0 → 0.5.0 |

---

### Task 1: Migration — comments, notification_inbox, email_pref, audit_log.workspace_id

**Files:**
- Create: `worker/migrations/007_comments_notifications.sql`

**Interfaces:** Produces the schema every later task depends on. Not run against remote D1 in this task — execution happens in the final deploy task, after code review, per Global Constraints.

- [ ] **Step 1:** Create `worker/migrations/007_comments_notifications.sql` (content verbatim from spec §1, filename corrected):

```sql
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
```

- [ ] **Step 2: Validate locally** (scratch SQLite only — do NOT run against remote D1 yet). Note this migration must apply on top of the FULL current chain, not just the baseline — it depends on `users`, `workspaces`, `audit_log` as they exist after migrations 000–006:

```bash
cd portal-app/worker
rm -f /tmp/phase3-mig-check.db
for f in migrations/0*.sql; do sqlite3 /tmp/phase3-mig-check.db < "$f"; done
sqlite3 /tmp/phase3-mig-check.db < migrations/007_comments_notifications.sql   # idempotency
sqlite3 /tmp/phase3-mig-check.db ".tables"
sqlite3 /tmp/phase3-mig-check.db ".schema users" | grep email_pref
sqlite3 /tmp/phase3-mig-check.db ".schema audit_log" | grep workspace_id
rm /tmp/phase3-mig-check.db
```

  Expect: no errors on the first pass; the **second** run of `007` will error on `ALTER TABLE ... ADD COLUMN` (columns already exist) and on `CREATE TABLE` (no `IF NOT EXISTS` on the new tables, unlike Phase 2's `002_collab_core.sql`) — that's expected and fine, since the migration runner (`worker/scripts/migrate.js`) tracks applied migrations in `schema_migrations` and never re-runs a file that already succeeded. Confirm the *first* pass is clean; do not add `IF NOT EXISTS` purely to make the idempotency check pass twice — that would mask a real double-apply bug on remote D1 that the runner is supposed to prevent structurally.
- [ ] **Step 3: Commit.**

```bash
git add worker/migrations/007_comments_notifications.sql
git commit -m "feat(portal): comments + notification_inbox schema, email_pref, audit_log.workspace_id (not yet applied)"
```

---

### Task 2: Pure helpers — mention parsing, email-pref filter, comment authz

**Files:**
- Modify: `worker/src/auth.js` (append after `memberChangeViolation`, ~line 349)
- Test: `worker/src/auth.test.js`

**Interfaces:**
- Produces (Tasks 4/5 rely on these exact names):
  - `parseMentions(body, memberUsernames) → string[]` — extracts `@username` tokens from `body`, returns only those matching an entry in `memberUsernames` (case-sensitive exact match on the token following `@`, terminated by whitespace or end-of-string; no partial/substring matches). Deduplicated, order-preserving.
  - `shouldEmailForPref(emailPref, eventType) → boolean` — `'all'` → always `true`; `'none'` → always `false`; `'mentions'` → `true` only when `eventType === 'comment.mention'`.
  - `isCommentEditableBy(user, comment) → boolean` — `true` iff `comment.deleted_at` is falsy AND `comment.author_id === (user.dbUserId || user.userId)`.
  - `commentDeleteViolation(user, comment, workspaceSlug) → string | null` — non-null message = blocked. Allowed: comment author, `hasWorkspaceAdminPermission(user, workspaceSlug)`, or `user.role === 'admin'`. (The latter two overlap when `workspaceSlug` is known, but `hasWorkspaceAdminPermission` already covers the global-admin case — don't duplicate the check, just call it.)

- [ ] **Step 1: Write the failing tests.** Append to `worker/src/auth.test.js` (extend the import line to add the four new names):

```javascript
describe('parseMentions', () => {
  const members = ['rmeadows', 'cdepalma', 'armeadows']

  it('extracts a single mention matching a member', () => {
    expect(parseMentions('hey @cdepalma check this', members)).toEqual(['cdepalma'])
  })
  it('ignores a mention of a non-member', () => {
    expect(parseMentions('hey @randomguy check this', members)).toEqual([])
  })
  it('extracts multiple distinct mentions, deduplicated', () => {
    expect(parseMentions('@rmeadows and @cdepalma, also @rmeadows again', members)).toEqual(['rmeadows', 'cdepalma'])
  })
  it('does not match a mention embedded mid-word', () => {
    expect(parseMentions('email me at foo@cdepalma.com', members)).toEqual([])
  })
  it('returns empty for no mentions', () => {
    expect(parseMentions('just a plain comment', members)).toEqual([])
  })
})

describe('shouldEmailForPref', () => {
  it('all: every event type emails', () => {
    expect(shouldEmailForPref('all', 'comment.create')).toBe(true)
    expect(shouldEmailForPref('all', 'comment.mention')).toBe(true)
    expect(shouldEmailForPref('all', 'file.upload')).toBe(true)
  })
  it('none: nothing emails', () => {
    expect(shouldEmailForPref('none', 'comment.mention')).toBe(false)
    expect(shouldEmailForPref('none', 'file.upload')).toBe(false)
  })
  it('mentions: only comment.mention emails', () => {
    expect(shouldEmailForPref('mentions', 'comment.mention')).toBe(true)
    expect(shouldEmailForPref('mentions', 'comment.create')).toBe(false)
    expect(shouldEmailForPref('mentions', 'file.upload')).toBe(false)
  })
})

describe('isCommentEditableBy', () => {
  it('true for the author on a non-deleted comment', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-1', deleted_at: null })).toBe(true)
  })
  it('false for a non-author', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-2', deleted_at: null })).toBe(false)
  })
  it('false for the author once the comment is deleted', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-1', deleted_at: '2026-07-21 10:00:00' })).toBe(false)
  })
})

describe('commentDeleteViolation', () => {
  it('allows the author', () => {
    const user = makeUser({ dbUserId: 'usr-1', role: 'client' })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('allows a wsAdmin deleting someone else\'s comment', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'client', workspacePermissions: { ws: 'admin' } })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('allows a global admin regardless of permission entry', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'admin', workspacePermissions: {} })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('blocks a non-author, non-wsAdmin', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'client', workspacePermissions: {} })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toMatch(/author|admin/i)
  })
})
```

- [ ] **Step 2: Run to verify failure.** `npm test` → expect FAIL: `parseMentions is not a function` etc.

- [ ] **Step 3: Implement.** Append to `worker/src/auth.js`:

```javascript
// Extracts @username tokens from a comment body, keeping only tokens that
// match a member of the workspace the comment belongs to. Silent no-op for
// non-members — never an error, no cross-workspace leakage (spec §2).
export function parseMentions(body, memberUsernames) {
  const memberSet = new Set(memberUsernames)
  const matches = body.match(/@([a-zA-Z0-9_-]+)/g) || []
  const found = []
  const seen = new Set()
  for (const m of matches) {
    const username = m.slice(1)
    if (memberSet.has(username) && !seen.has(username)) {
      seen.add(username)
      found.push(username)
    }
  }
  return found
}

// Whether a notification email should be sent to a recipient with the given
// email_pref, for the given event type (spec §4). Never gates the inbox row —
// only the email leg.
export function shouldEmailForPref(emailPref, eventType) {
  if (emailPref === 'none') return false
  if (emailPref === 'mentions') return eventType === 'comment.mention'
  return true // 'all'
}

// Edit ceiling (spec §2): author only, and only while the comment is not
// (soft-)deleted. Not even wsAdmin may alter someone else's words.
export function isCommentEditableBy(user, comment) {
  if (comment.deleted_at) return false
  return comment.author_id === (user.dbUserId || user.userId)
}

// Delete ceiling (spec §2): author, wsAdmin, or global admin. Always soft
// delete at the call site — this only decides who may do it.
export function commentDeleteViolation(user, comment, workspaceSlug) {
  const isAuthor = comment.author_id === (user.dbUserId || user.userId)
  if (isAuthor || hasWorkspaceAdminPermission(user, workspaceSlug)) {
    return null
  }
  return 'Only the comment author or a workspace admin may delete this comment'
}
```

- [ ] **Step 4: Run tests.** `npm test` → all pass (22 existing + new = expect ~37).
- [ ] **Step 5: Lint + commit.**

```bash
git add worker/src/auth.js worker/src/auth.test.js
git commit -m "feat(portal): mention parsing, email-pref filter, comment edit/delete authz helpers"
```

---

### Task 3: `logAudit` gains `workspace_id`; backfill existing call sites

**Files:**
- Modify: `worker/src/audit.js`
- Modify: `worker/src/routes/workspaces.js`, `files.js`, `folders.js`, `members.js`

**Interfaces:** `logAudit(env, userId, action, details = {})` — `details.workspaceId` is now bound into the new `audit_log.workspace_id` column. No signature change; omitting it leaves the column `NULL` (backward compatible with every untouched call site).

- [ ] **Step 1: `worker/src/audit.js`** — add the column to the `INSERT` and the bind list:

```javascript
export async function logAudit(env, userId, action, details = {}) {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, workspace_id, metadata_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        id,
        userId,
        action,
        details.resourceType || null,
        details.resourceId || null,
        details.workspaceId || null,
        JSON.stringify(details),
        details.ipAddress || null,
      )
      .run()
  } catch (err) {
    console.error('Audit log write failed:', err.message)
  }
}
```

- [ ] **Step 2: `workspaces.js`.** Add `workspaceId: workspace.id` to the `details` object of `handleGetWorkspace`'s `workspace.view` call and `handleUpdateWorkspace`'s `workspace.update` call ONLY. Do **not** touch `handleCreateWorkspace` (workspace.create), `handleDeleteWorkspace` (workspace.delete), or `handleUpdateUserWorkspaces` (user.workspaces.update) — these stay global per the Current-state facts table above.
- [ ] **Step 3: `files.js`.** Add `workspaceId: workspace.id` (upload) or `workspaceId: file.workspace_id` (replace, delete.denied, delete, download, move) to all 6 `logAudit` call sites' `details` objects.
- [ ] **Step 4: `folders.js`.** Add `workspaceId: workspace.id` (create) or `workspaceId: folder.workspace_id` (rename, delete, move) to all 4 call sites.
- [ ] **Step 5: `members.js`.** Add `workspaceId: workspace.id` to `member.permission_change[.denied]` and `member.remove[.denied]` and `member.invite` (all have `workspace` in scope via `getWorkspaceBySlug`); add `workspaceId: invitation.workspace_id` to `invitation.revoke`.
- [ ] **Step 6: Verify.** `npm test` passes (no behavior change to test — these are additive fields on an untested `details` object); `npx eslint worker/src/audit.js worker/src/routes/workspaces.js worker/src/routes/files.js worker/src/routes/folders.js worker/src/routes/members.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 7: Commit.**

```bash
git add worker/src/audit.js worker/src/routes/workspaces.js worker/src/routes/files.js worker/src/routes/folders.js worker/src/routes/members.js
git commit -m "feat(portal): populate audit_log.workspace_id at every call site that has one in scope"
```

---

### Task 4: `notify.js` — inbox writes, email-pref gating, mention recipients

**Files:**
- Modify: `worker/src/notify.js`

**Interfaces:**
- Produces for Task 5: `notifyWorkspaceEvent` gains an optional `link` field (in-app route stored on the inbox row) and an optional `recipientOverride` array of `{id, email, email_pref}` — when present, skips `resolveRecipients` entirely and uses this list instead (the `comment.mention` path). Produces `resolveMentionRecipients(env, userIds) → [{id, email, email_pref}]`.
- Consumes from Task 2: `shouldEmailForPref` (import from `../auth.js` — first cross-import from `notify.js` into `auth.js`'s namespace; confirm no circular import: `auth.js` does not import from `notify.js`).

- [ ] **Step 1: `resolveRecipients` gains `email_pref`.** Replace both `SELECT`s:

```javascript
export async function resolveRecipients(env, workspaceId) {
  const admins = await env.DB.prepare(
    "SELECT id, email, email_pref FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL",
  ).all()

  let members = { results: [] }
  if (workspaceId) {
    members = await env.DB.prepare(
      `SELECT u.id, u.email, u.email_pref FROM users u
       INNER JOIN user_workspaces uw ON uw.user_id = u.id
       WHERE uw.workspace_id = ? AND u.status = 'active' AND u.email IS NOT NULL`,
    ).bind(workspaceId).all()
  }

  return {
    admins: admins.results.map((u) => ({ email: u.email, userId: u.id, emailPref: u.email_pref })),
    workspaceMembers: members.results.map((u) => ({ email: u.email, userId: u.id, emailPref: u.email_pref })),
  }
}

/**
 * Resolve the specific users @mentioned in a comment (spec §4 — a narrower,
 * separate path from resolveRecipients' "everyone in the workspace").
 */
export async function resolveMentionRecipients(env, userIds) {
  if (!userIds || userIds.length === 0) return []
  const placeholders = userIds.map(() => '?').join(', ')
  const result = await env.DB.prepare(
    `SELECT id, email, email_pref FROM users WHERE id IN (${placeholders}) AND status = 'active' AND email IS NOT NULL`,
  ).bind(...userIds).all()
  return result.results.map((u) => ({ email: u.email, userId: u.id, emailPref: u.email_pref }))
}
```

- [ ] **Step 2: Import `shouldEmailForPref`.** Add to the top of `notify.js`: `import { shouldEmailForPref } from './auth.js'`.

- [ ] **Step 3: Restructure `notifyWorkspaceEvent`** to accept `link` and `recipientOverride`, write an inbox row per recipient unconditionally, and gate only the email leg:

```javascript
export function notifyWorkspaceEvent(env, ctx, { eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata, link, recipientOverride }) {
  const task = (async () => {
    try {
      let allRecipients
      if (recipientOverride) {
        // comment.mention path: exact recipient set, no admin/actor-exclusion logic —
        // a mention is always meant for the mentioned person, admin or not.
        allRecipients = new Map(recipientOverride.map((r) => [r.email.toLowerCase(), r]))
      } else {
        const { admins, workspaceMembers } = await resolveRecipients(env, workspaceId)
        const adminEmails = new Set(admins.map((a) => a.email.toLowerCase()))
        allRecipients = new Map()
        for (const r of [...admins, ...workspaceMembers]) {
          if (!r.email) continue
          const emailLower = r.email.toLowerCase()
          const isActor = emailLower === (actorEmail || '').toLowerCase()
          const isAdmin = adminEmails.has(emailLower)
          if (isAdmin || !isActor) {
            allRecipients.set(emailLower, r)
          }
        }
      }

      if (allRecipients.size === 0) return

      const subject = `[WSL Portal] ${title}`
      const emailHtml = buildEmailHtml(title, bodyLines)
      const text = bodyLines.join('\n')

      for (const [email, recipient] of allRecipients) {
        // Inbox row — unconditional. The bell reflects everything relevant
        // regardless of email settings; email is opt-out, the inbox isn't.
        await env.DB.prepare(
          `INSERT INTO notification_inbox (id, user_id, event_type, title, body, link, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).bind(crypto.randomUUID(), recipient.userId, eventType, title, text, link || null).run()

        if (!shouldEmailForPref(recipient.emailPref || 'all', eventType)) continue

        await sendEmail(env, {
          to: email,
          subject,
          html: emailHtml,
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
```

  (`emailPref || 'all'` covers any row somehow missing the column value — the migration's `NOT NULL DEFAULT 'all'` means this should never actually be null/undefined in practice; the fallback is defensive, not load-bearing.)

- [ ] **Step 4: Verify.** `npm test` passes (existing `notify.test.js` escaping tests are untouched by this change — `buildEmailHtml`/`escapeHtml` signatures didn't change); `npx eslint worker/src/notify.js` clean.
- [ ] **Step 5: Commit.**

```bash
git add worker/src/notify.js
git commit -m "feat(portal): notifyWorkspaceEvent writes inbox rows unconditionally, gates email by email_pref, adds mention-recipient path"
```

---

### Task 5: Comments — CRUD, mention wiring, router

**Files:**
- Create: `worker/src/routes/comments.js`
- Modify: `worker/src/router.js`

**Interfaces:**
- Consumes: `requireWorkspaceAccess`, `hasWorkspaceWriteAccess`, `hasWorkspaceAdminPermission`, `parseMentions`, `isCommentEditableBy`, `commentDeleteViolation` (Task 2); `logAudit`/`getClientIp`; `notifyWorkspaceEvent`/`resolveMentionRecipients`/`escapeHtml` (Task 4); `getWorkspaceBySlug` (already exported from `members.js`).
- Produces for Task 8 (frontend): `GET .../comments?entity_type=&entity_id=` → `{ comments: [...] }`; `POST .../comments` → 201; `PATCH /api/comments/:id` → 200; `DELETE /api/comments/:id` → 200.

- [ ] **Step 1: Create `worker/src/routes/comments.js`:**

```javascript
// worker/src/routes/comments.js
// Workspace + file comments (Phase 3). Ceilings enforced server-side via the
// pure helpers in ../auth.js — same discipline as members.js.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, parseMentions, isCommentEditableBy, commentDeleteViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, resolveMentionRecipients, escapeHtml } from '../notify.js'
import { getWorkspaceBySlug } from './members.js'

/** GET /api/workspaces/:slug/comments?entity_type=&entity_id= — any member */
export async function handleListComments(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const url = new URL(request.url)
  const entityType = url.searchParams.get('entity_type')
  const entityId = url.searchParams.get('entity_id')
  if (!entityType || !entityId) {
    return errorResponse('entity_type and entity_id are required', 400)
  }

  const result = await env.DB.prepare(
    `SELECT c.id, c.entity_type, c.entity_id, c.parent_comment_id, c.author_id,
            c.body, c.created_at, c.edited_at, c.deleted_at, u.username AS author_username
     FROM comments c INNER JOIN users u ON u.id = c.author_id
     WHERE c.workspace_id = ? AND c.entity_type = ? AND c.entity_id = ?
     ORDER BY c.created_at ASC`,
  ).bind(workspace.id, entityType, entityId).all()

  // Soft-deleted comments render as "[deleted]" client-side but the row (and
  // its replies) still ships — the client checks deleted_at, never omits.
  return jsonResponse({ comments: result.results })
}

/** POST /api/workspaces/:slug/comments — wsWrite. Body: {entity_type, entity_id, parent_comment_id?, body} */
export async function handleCreateComment(request, env, user, params, ctx) {
  if (!hasWorkspaceWriteAccess(user, params.slug)) {
    throw errorResponse('Forbidden: write permission required to comment', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let reqBody
  try { reqBody = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const { entity_type: entityType, entity_id: entityId, parent_comment_id: parentId, body } = reqBody

  if (!['workspace', 'file', 'task'].includes(entityType)) {
    return errorResponse('entity_type must be one of: workspace, file, task', 400)
  }
  if (!entityId) return errorResponse('entity_id is required', 400)
  if (!body || !body.trim()) return errorResponse('body is required', 400)

  if (parentId) {
    const parent = await env.DB.prepare('SELECT id, parent_comment_id FROM comments WHERE id = ? AND workspace_id = ?')
      .bind(parentId, workspace.id).first()
    if (!parent) return errorResponse('Parent comment not found', 404)
    // One level deep only (spec §2) — reject, never re-parent.
    if (parent.parent_comment_id) return errorResponse('Cannot reply to a reply', 400)
  }

  const commentId = `cmt-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO comments (id, workspace_id, entity_type, entity_id, parent_comment_id, author_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).bind(commentId, workspace.id, entityType, entityId, parentId || null, user.dbUserId, body.trim()).run()

  await logAudit(env, user.userId, 'comment.create', {
    resourceType: 'comment', resourceId: commentId,
    workspaceId: workspace.id, workspaceSlug: params.slug,
    entityType, entityId,
    ipAddress: getClientIp(request),
  })

  const link = entityType === 'file'
    ? `/workspace/${params.slug}?tab=files&fileId=${entityId}&comments=1`
    : `/workspace/${params.slug}?tab=discussion`

  // General broadcast — same recipient resolution as every other workspace
  // event; email leg is filtered to email_pref='all' inside notifyWorkspaceEvent.
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'comment.create',
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: `New comment in ${escapeHtml(workspace.name)}`,
    bodyLines: [
      `<strong>${escapeHtml(user.email || user.username || 'Someone')}</strong> commented:`,
      escapeHtml(body.trim()),
    ],
    actorEmail: user.email,
    link,
    metadata: { commentId, entityType, entityId },
  })

  // Mentions — a separate, narrower emission (spec §4): resolved from parsed
  // @username matches against THIS workspace's members only, never "everyone".
  const memberRows = await env.DB.prepare(
    `SELECT u.id, u.username FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id WHERE uw.workspace_id = ?`,
  ).bind(workspace.id).all()
  const memberUsernames = memberRows.results.map((r) => r.username)
  const mentionedUsernames = parseMentions(body, memberUsernames)
  if (mentionedUsernames.length > 0) {
    const mentionedIds = memberRows.results
      .filter((r) => mentionedUsernames.includes(r.username))
      .map((r) => r.id)
    const recipients = await resolveMentionRecipients(env, mentionedIds)
    if (recipients.length > 0) {
      notifyWorkspaceEvent(env, ctx, {
        eventType: 'comment.mention',
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        title: `You were mentioned in ${escapeHtml(workspace.name)}`,
        bodyLines: [
          `<strong>${escapeHtml(user.email || user.username || 'Someone')}</strong> mentioned you:`,
          escapeHtml(body.trim()),
        ],
        actorEmail: user.email,
        link,
        recipientOverride: recipients.map((r) => ({ email: r.email, userId: r.userId, emailPref: r.emailPref })),
        metadata: { commentId, entityType, entityId },
      })
    }
  }

  return jsonResponse({ comment: { id: commentId, entity_type: entityType, entity_id: entityId, parent_comment_id: parentId || null, body: body.trim() } }, 201)
}

/** PATCH /api/comments/:id — author only, non-deleted. Body: {body} */
export async function handleEditComment(request, env, user, params) {
  const comment = await env.DB.prepare(
    `SELECT c.id, c.author_id, c.deleted_at, w.slug AS workspace_slug
     FROM comments c INNER JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ?`,
  ).bind(params.id).first()
  // A deleted comment is 404, not 403 — it no longer exists as far as the API
  // is concerned (spec §2).
  if (!comment || comment.deleted_at) return errorResponse('Comment not found', 404)

  if (!isCommentEditableBy(user, comment)) {
    await logAudit(env, user.userId, 'comment.edit.denied', {
      resourceType: 'comment', resourceId: comment.id,
      workspaceSlug: comment.workspace_slug, ipAddress: getClientIp(request),
    })
    throw errorResponse('Forbidden: only the comment author may edit it', 403)
  }

  let reqBody
  try { reqBody = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!reqBody.body || !reqBody.body.trim()) return errorResponse('body is required', 400)

  await env.DB.prepare(`UPDATE comments SET body = ?, edited_at = datetime('now') WHERE id = ?`)
    .bind(reqBody.body.trim(), comment.id).run()

  await logAudit(env, user.userId, 'comment.edit', {
    resourceType: 'comment', resourceId: comment.id,
    workspaceSlug: comment.workspace_slug, ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Comment updated' })
}

/** DELETE /api/comments/:id — author, wsAdmin, or global admin. Soft delete only. */
export async function handleDeleteComment(request, env, user, params) {
  const comment = await env.DB.prepare(
    `SELECT c.id, c.author_id, c.deleted_at, c.workspace_id, w.slug AS workspace_slug
     FROM comments c INNER JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ?`,
  ).bind(params.id).first()
  if (!comment || comment.deleted_at) return errorResponse('Comment not found', 404)

  const violation = commentDeleteViolation(user, comment, comment.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'comment.delete.denied', {
      resourceType: 'comment', resourceId: comment.id,
      workspaceSlug: comment.workspace_slug, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  // Soft delete only — never a hard DELETE (spec §2). Replies are untouched
  // and remain visible; the client renders this row as "[deleted]".
  await env.DB.prepare(`UPDATE comments SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(comment.id).run()

  await logAudit(env, user.userId, 'comment.delete', {
    resourceType: 'comment', resourceId: comment.id,
    workspaceId: comment.workspace_id, workspaceSlug: comment.workspace_slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Comment deleted' })
}
```

- [ ] **Step 2: Wire the router.** In `worker/src/router.js`, add the import:

```javascript
import {
  handleListComments,
  handleCreateComment,
  handleEditComment,
  handleDeleteComment,
} from './routes/comments.js'
```

  and insert this block after the invitations block (before the `/api/users` block, ~line 197):

```javascript
        params = matchPath('/api/workspaces/:slug/comments', pathname)
        if (params && method === 'GET') {
          return await handleListComments(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateComment(request, env, user, params, ctx)
        }

        params = matchPath('/api/comments/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleEditComment(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteComment(request, env, user, params)
        }
```

- [ ] **Step 3: Verify.** `npm test` passes; `npx eslint worker/src/routes/comments.js worker/src/router.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/comments.js worker/src/router.js
git commit -m "feat(portal): comments CRUD — one-level replies, soft delete, mention-triggered notifications"
```

---

### Task 6: Notifications — inbox list, mark-read, email preference

**Files:**
- Modify: `worker/src/routes/me.js`
- Modify: `worker/src/router.js`

**Interfaces:**
- Produces for Task 8: `GET /api/notifications?unread=1&limit=&before=` → `{ notifications: [...] }`; `POST /api/notifications/mark-read` body `{ids: [...]}` or `{all: true}` → 200; `PATCH /api/me/preferences` body `{email_pref}` → 200; `handleMe` response gains `email_pref`.

- [ ] **Step 1: Extend `handleMe`** in `worker/src/routes/me.js`:

```javascript
/** GET /api/me — the authenticated user's D1 role, workspaces, permissions, and prefs. */
export async function handleMe(request, env, user) {
  const row = await env.DB.prepare('SELECT email_pref FROM users WHERE id = ?')
    .bind(user.dbUserId || user.userId).first()

  return jsonResponse({
    userId: user.dbUserId || user.userId,
    role: user.role,
    workspaceSlugs: user.workspaceSlugs,
    workspacePermissions: user.workspacePermissions,
    email: user.email,
    emailPref: row?.email_pref || 'all',
  })
}

/** GET /api/notifications?unread=1&limit=50&before= — self */
export async function handleListNotifications(request, env, user) {
  const url = new URL(request.url)
  const unreadOnly = url.searchParams.get('unread') === '1'
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
  const before = url.searchParams.get('before')

  const conditions = ['user_id = ?']
  const bindings = [user.dbUserId || user.userId]
  if (unreadOnly) conditions.push('read_at IS NULL')
  if (before) { conditions.push('created_at < ?'); bindings.push(before) }

  const result = await env.DB.prepare(
    `SELECT id, event_type, title, body, link, read_at, created_at FROM notification_inbox
     WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...bindings, limit).all()

  return jsonResponse({ notifications: result.results })
}

/** POST /api/notifications/mark-read — self. Body: {ids: [...]} or {all: true} */
export async function handleMarkNotificationsRead(request, env, user) {
  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const userId = user.dbUserId || user.userId
  if (body.all) {
    await env.DB.prepare(`UPDATE notification_inbox SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`)
      .bind(userId).run()
    return jsonResponse({ message: 'All notifications marked read' })
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return errorResponse('ids (non-empty array) or all:true is required', 400)
  }
  const placeholders = body.ids.map(() => '?').join(', ')
  await env.DB.prepare(
    `UPDATE notification_inbox SET read_at = datetime('now') WHERE user_id = ? AND id IN (${placeholders})`,
  ).bind(userId, ...body.ids).run()

  return jsonResponse({ message: 'Notifications marked read' })
}

/** PATCH /api/me/preferences — self. Body: {email_pref} */
export async function handleUpdatePreferences(request, env, user) {
  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { email_pref: emailPref } = body
  if (!['all', 'mentions', 'none'].includes(emailPref)) {
    return errorResponse('email_pref must be one of: all, mentions, none', 400)
  }

  await env.DB.prepare(`UPDATE users SET email_pref = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(emailPref, user.dbUserId || user.userId).run()

  return jsonResponse({ message: 'Preferences updated', email_pref: emailPref })
}
```

  Add `errorResponse` to `me.js`'s existing `import { jsonResponse } from '../cors.js'` → `import { jsonResponse, errorResponse } from '../cors.js'`.

- [ ] **Step 2: Wire the router.** Extend the `me.js` import in `router.js` to `import { handleHealth, handleMe, handleListNotifications, handleMarkNotificationsRead, handleUpdatePreferences } from './routes/me.js'`, and add (after the comments block from Task 5):

```javascript
        if (pathname === '/api/notifications' && method === 'GET') {
          return await handleListNotifications(request, env, user)
        }
        if (pathname === '/api/notifications/mark-read' && method === 'POST') {
          return await handleMarkNotificationsRead(request, env, user)
        }

        if (pathname === '/api/me/preferences' && method === 'PATCH') {
          return await handleUpdatePreferences(request, env, user)
        }
```

- [ ] **Step 3: Verify.** `npm test` passes; `npx eslint worker/src/routes/me.js worker/src/router.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/me.js worker/src/router.js
git commit -m "feat(portal): notification inbox list/mark-read, email preference endpoint, /api/me gains emailPref"
```

---

### Task 7: Activity feed endpoint

**Files:**
- Modify: `worker/src/routes/workspaces.js` (new `handleGetActivity`)
- Modify: `worker/src/router.js`

**Interfaces:** Produces for Task 9: `GET /api/workspaces/:slug/activity?limit=&before=` → `{ activity: [...] }`, paginated same shape as notifications (`limit`/`before` cursor on `created_at`).

- [ ] **Step 1: Add `handleGetActivity`** to `worker/src/routes/workspaces.js` (any workspace member — same access check as `handleGetWorkspace`):

```javascript
/**
 * GET /api/workspaces/:slug/activity — paginated audit_log scoped to this
 * workspace. Excludes workspace.view (Global Constraints: populated in the
 * column for consistency, but noisy in a human-facing feed — filtered here,
 * not at write time, so the exclusion is visible and easy to revisit).
 */
export async function handleGetActivity(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
  const before = url.searchParams.get('before')

  const conditions = ['a.workspace_id = ?', "a.action != 'workspace.view'"]
  const bindings = [workspace.id]
  if (before) { conditions.push('a.created_at < ?'); bindings.push(before) }

  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata_json, a.created_at,
            u.username AS actor_username
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id OR u.clerk_id = a.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC LIMIT ?`,
  ).bind(...bindings, limit).all()

  const activity = result.results.map((r) => ({
    ...r,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
  }))

  return jsonResponse({ activity })
}
```

  (`LEFT JOIN ... u.id = a.user_id OR u.clerk_id = a.user_id` mirrors the existing `uploaded_by_name` join pattern in `files.js`/`folders.js` — `audit_log.user_id` is sometimes a Clerk ID, sometimes a `dbUserId`, depending on the call site's era.)

- [ ] **Step 2: Wire the router.** Extend the `workspaces.js` import in `router.js` with `handleGetActivity`, and add (grouped with the other `/api/workspaces/:slug/...` blocks, e.g. right after the folders block):

```javascript
        params = matchPath('/api/workspaces/:slug/activity', pathname)
        if (params && method === 'GET') {
          return await handleGetActivity(request, env, user, params)
        }
```

- [ ] **Step 3: Verify.** `npm test` passes; `npx eslint worker/src/routes/workspaces.js worker/src/router.js` clean; `cd worker && npx wrangler deploy --dry-run` bundles.
- [ ] **Step 4: Commit.**

```bash
git add worker/src/routes/workspaces.js worker/src/router.js
git commit -m "feat(portal): workspace activity feed endpoint, excludes noisy workspace.view events"
```

---

### Task 8: Frontend plumbing — API client, CommentThread component

**Files:**
- Modify: `src/api/client.js`
- Create: `src/components/CommentThread.jsx`

**Interfaces:**
- Produces for Tasks 9–10: `listComments`, `createComment`, `editComment`, `deleteComment`, `listActivity`, `listNotifications`, `markNotificationsRead`, `updatePreferences`; `<CommentThread workspaceSlug entityType entityId />`.

- [ ] **Step 1: API client.** In `src/api/client.js`, after the invitations methods (before "Audit log"), add:

```javascript
    // Comments (Phase 3)
    listComments: (slug, entityType, entityId) =>
      apiFetch(`/api/workspaces/${slug}/comments?${new URLSearchParams({ entity_type: entityType, entity_id: entityId })}`, getToken),
    createComment: (slug, data) =>
      apiFetch(`/api/workspaces/${slug}/comments`, getToken, { method: 'POST', body: JSON.stringify(data) }),
    editComment: (id, body) =>
      apiFetch(`/api/comments/${id}`, getToken, { method: 'PATCH', body: JSON.stringify({ body }) }),
    deleteComment: (id) => apiFetch(`/api/comments/${id}`, getToken, { method: 'DELETE' }),

    // Activity (Phase 3)
    listActivity: (slug, params = {}) =>
      apiFetch(`/api/workspaces/${slug}/activity?${new URLSearchParams(params)}`, getToken),

    // Notifications (Phase 3)
    listNotifications: (params = {}) =>
      apiFetch(`/api/notifications?${new URLSearchParams(params)}`, getToken),
    markNotificationsRead: (data) =>
      apiFetch('/api/notifications/mark-read', getToken, { method: 'POST', body: JSON.stringify(data) }),
    updatePreferences: (emailPref) =>
      apiFetch('/api/me/preferences', getToken, { method: 'PATCH', body: JSON.stringify({ email_pref: emailPref }) }),
```

- [ ] **Step 2: `CommentThread` component.** Create `src/components/CommentThread.jsx` (plain-text body per spec — `whiteSpace: 'pre-wrap'` to preserve line breaks; `@mentions` highlighted via a simple regex-split render, no markdown/HTML parsing of the body):

```javascript
import { useState, useEffect, useCallback } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'

function renderBody(body) {
  // Plain text only (spec §3) — split on @mentions for highlighting, nothing else parsed.
  const parts = body.split(/(@[a-zA-Z0-9_-]+)/g)
  return parts.map((part, i) =>
    part.startsWith('@')
      ? <span key={i} className="mention">{part}</span>
      : <span key={i}>{part}</span>,
  )
}

export default function CommentThread({ workspaceSlug, entityType, entityId }) {
  const api = useApiClient()
  const { d1User, isAdmin } = usePortalAuth()
  const wsAdmin = isAdmin || d1User?.workspacePermissions?.[workspaceSlug] === 'admin'
  const myUserId = d1User?.userId

  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listComments(workspaceSlug, entityType, entityId)
      setComments(data.comments)
      setError(null)
    } catch {
      setError('Could not load comments.')
    } finally {
      setLoading(false)
    }
  }, [api, workspaceSlug, entityType, entityId])

  useEffect(() => { load() }, [load])

  const post = async () => {
    if (!draft.trim()) return
    setPosting(true)
    try {
      await api.createComment(workspaceSlug, {
        entity_type: entityType, entity_id: entityId,
        parent_comment_id: replyTo, body: draft.trim(),
      })
      setDraft('')
      setReplyTo(null)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not post comment.')
    } finally {
      setPosting(false)
    }
  }

  const saveEdit = async (id) => {
    if (!editDraft.trim()) return
    try {
      await api.editComment(id, editDraft.trim())
      setEditingId(null)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not edit comment.')
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this comment?')) return
    try {
      await api.deleteComment(id)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not delete comment.')
    }
  }

  const topLevel = comments.filter((c) => !c.parent_comment_id)
  const repliesTo = (id) => comments.filter((c) => c.parent_comment_id === id)

  const renderComment = (c, isReply) => (
    <div key={c.id} className={`comment ${isReply ? 'comment--reply' : ''}`}>
      <div className="comment__meta mono">
        <strong>{c.author_username}</strong> · {new Date(c.created_at).toLocaleString()}
        {c.edited_at && !c.deleted_at && ' (edited)'}
      </div>
      {c.deleted_at ? (
        <div className="comment__body comment__body--deleted">[deleted]</div>
      ) : editingId === c.id ? (
        <div className="comment__edit">
          <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={2} />
          <button className="btn btn--secondary btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={() => saveEdit(c.id)}>Save</button>
        </div>
      ) : (
        <>
          <div className="comment__body">{renderBody(c.body)}</div>
          <div className="comment__actions">
            {!isReply && <button className="link-btn" onClick={() => setReplyTo(c.id)}>Reply</button>}
            {c.author_id === myUserId && (
              <button className="link-btn" onClick={() => { setEditingId(c.id); setEditDraft(c.body) }}>Edit</button>
            )}
            {(c.author_id === myUserId || wsAdmin) && (
              <button className="link-btn link-btn--danger" onClick={() => remove(c.id)}>Delete</button>
            )}
          </div>
        </>
      )}
      {!isReply && repliesTo(c.id).map((r) => renderComment(r, true))}
    </div>
  )

  if (loading) return <div className="comment-thread__loading"><div className="spinner" /></div>

  return (
    <div className="comment-thread">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
      <div className="comment-thread__list">
        {topLevel.length === 0
          ? <div className="comment-thread__empty">No comments yet.</div>
          : topLevel.map((c) => renderComment(c, false))}
      </div>
      <div className="comment-thread__composer">
        {replyTo && (
          <div className="comment-thread__replying mono">
            Replying… <button className="link-btn" onClick={() => setReplyTo(null)}>cancel</button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment… use @username to mention a member"
          rows={3}
        />
        <button className="btn btn--primary" onClick={post} disabled={posting || !draft.trim()}>
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  )
}
```

  (During implementation, check `d1User.userId` is actually populated by `/api/me` — Task 6's `handleMe` returns `userId: user.dbUserId || user.userId`, so this matches. Add `.comment`, `.comment--reply`, `.comment__*`, `.mention`, `.link-btn*`, `.comment-thread*` styles to `WorkspaceDetail.css` — reuse existing `.workspace__alert`/`.spinner`/`.btn` classes, don't duplicate them.)

- [ ] **Step 2: Verify.** `npm run build` clean; `npx eslint src/` clean.
- [ ] **Step 3: Commit.**

```bash
git add src/api/client.js src/components/CommentThread.jsx
git commit -m "feat(portal): comment/activity/notification API client methods, shared CommentThread component"
```

---

### Task 9: Discussion + Activity tabs, file comment panel

**Files:**
- Create: `src/components/workspace/ActivityTab.jsx`
- Create: `src/components/FileCommentPanel.jsx`
- Modify: `src/pages/WorkspaceDetail.jsx`

**Interfaces:** Consumes Task 8's `CommentThread` and api client methods.

- [ ] **Step 1: `ActivityTab`.** Create `src/components/workspace/ActivityTab.jsx` — paginated read-only list, `limit`/`before` cursor (append-on-scroll or a simple "Load more" button; a "Load more" button is simpler and matches this codebase's lack of infinite-scroll elsewhere):

```javascript
import { useState, useEffect, useCallback } from 'react'
import { useApiClient } from '../../api/client'

function describeAction(item) {
  // Minimal human labels for the event types this phase actually produces
  // plus everything Phase 1/2 already write — extend as new actions ship.
  const labels = {
    'comment.create': 'commented',
    'comment.edit': 'edited a comment',
    'comment.delete': 'deleted a comment',
    'file.upload': 'uploaded a file',
    'file.replace': 'replaced a file',
    'file.delete': 'deleted a file',
    'file.move': 'moved a file',
    'folder.create': 'created a folder',
    'folder.rename': 'renamed a folder',
    'folder.delete': 'deleted a folder',
    'folder.move': 'moved a folder',
    'member.invite': 'invited a member',
    'member.join': 'joined the workspace',
    'member.permission_change': 'changed a member\'s permission',
    'member.remove': 'removed a member',
    'workspace.update': 'updated workspace settings',
  }
  return labels[item.action] || item.action
}

export default function ActivityTab({ slug }) {
  const api = useApiClient()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  const load = useCallback(async (before) => {
    const data = await api.listActivity(slug, before ? { before } : {})
    setHasMore(data.activity.length === 50)
    return data.activity
  }, [api, slug])

  useEffect(() => {
    setLoading(true)
    load().then(setItems).finally(() => setLoading(false))
  }, [load])

  const loadMore = async () => {
    if (items.length === 0) return
    setLoadingMore(true)
    try {
      const more = await load(items[items.length - 1].created_at)
      setItems((prev) => [...prev, ...more])
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) return <div className="activity-tab__loading"><div className="spinner" /></div>

  return (
    <div className="activity-tab">
      {items.length === 0 ? (
        <div className="activity-tab__empty">No activity yet.</div>
      ) : (
        <ul className="activity-tab__list">
          {items.map((item) => (
            <li key={item.id} className="activity-tab__item">
              <span className="mono">{new Date(item.created_at).toLocaleString()}</span>
              {' — '}
              <strong>{item.actor_username || 'Someone'}</strong> {describeAction(item)}
            </li>
          ))}
        </ul>
      )}
      {hasMore && items.length > 0 && (
        <button className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `FileCommentPanel`.** Create `src/components/FileCommentPanel.jsx` — a slide-over wrapping `CommentThread`:

```javascript
import CommentThread from '../CommentThread'

export default function FileCommentPanel({ workspaceSlug, file, onClose }) {
  return (
    <div className="slide-over-overlay" onClick={onClose}>
      <div className="slide-over" onClick={(e) => e.stopPropagation()}>
        <div className="slide-over__header">
          <h3>Comments — {file.filename}</h3>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>
        <CommentThread workspaceSlug={workspaceSlug} entityType="file" entityId={file.id} />
      </div>
    </div>
  )
}
```

  (Move this file to `src/components/FileCommentPanel.jsx` — the import path above assumes it sits alongside `CommentThread.jsx` at `src/components/`; adjust the relative import if the file structure table's paths shift during implementation.)

- [ ] **Step 3: Wire into `WorkspaceDetail.jsx`.**
  - Import `CommentThread`, `ActivityTab`, `FileCommentPanel`.
  - Add state: `const [commentingFile, setCommentingFile] = useState(null)`.
  - Extend the tab bar (~line 379-385) with two more buttons, always visible (Discussion/Activity are read-open to any member, unlike Settings):
    ```javascript
    <button className={`workspace__tab ${activeTab === 'discussion' ? 'workspace__tab--active' : ''}`} onClick={() => setActiveTab('discussion')}>Discussion</button>
    <button className={`workspace__tab ${activeTab === 'activity' ? 'workspace__tab--active' : ''}`} onClick={() => setActiveTab('activity')}>Activity</button>
    ```
  - Add tab bodies alongside the existing `{activeTab === 'members' && ...}` block:
    ```javascript
    {activeTab === 'discussion' && <CommentThread workspaceSlug={slug} entityType="workspace" entityId={workspace.id} />}
    {activeTab === 'activity' && <ActivityTab slug={slug} />}
    ```
  - In the file row's `<td className="file-actions">` (~line 533), add a "Comments" button before Download, available to any member (not gated on `canWrite`/`canUpload`/`canDelete` — reading/posting comments has its own ceiling already enforced server-side):
    ```javascript
    <button className="btn btn--secondary btn--sm" onClick={() => setCommentingFile(file)}>Comments</button>
    ```
  - Render the panel near the other modals at the bottom of the component:
    ```javascript
    {commentingFile && (
      <FileCommentPanel workspaceSlug={slug} file={commentingFile} onClose={() => setCommentingFile(null)} />
    )}
    ```
  - Support deep-linking from a notification (`?tab=discussion` / `?tab=files&fileId=...&comments=1`, per Task 5's `link` values): read `useSearchParams` on mount and set `activeTab`/`commentingFile` accordingly if present. (During implementation: `commentingFile` needs the fetched `file` object, not just an id — if the linked file isn't in the currently-loaded folder, this deep-link can only pre-select the Files tab and let the user open Comments manually; don't build folder-tree traversal just to auto-open the panel for a file in an unloaded folder — that's disproportionate to what a notification link needs to do.)

- [ ] **Step 4: Verify.** `npm run build` clean; `npx eslint src/` clean. Manually verify (dev server): posting a comment, replying once, rejecting a second-level reply (couldn't from the UI — the "Reply" button is hidden on replies per Step 1's `renderComment`, matching the server-side 400 as a backstop only), editing your own comment, deleting a comment leaves `[deleted]` with replies intact, Activity tab shows recent events without `workspace.view` noise.
- [ ] **Step 5: Commit.**

```bash
git add src/components/workspace/ActivityTab.jsx src/components/FileCommentPanel.jsx src/pages/WorkspaceDetail.jsx
git commit -m "feat(portal): Discussion + Activity tabs, file comment slide-over panel"
```

---

### Task 10: Topnav bell, email preference setting

**Files:**
- Create: `src/components/NotificationBell.jsx`
- Modify: `src/layouts/PortalLayout.jsx`
- Modify: `src/components/workspace/WorkspaceSettingsTab.jsx`

**Interfaces:** Consumes Task 8's `listNotifications`/`markNotificationsRead`/`updatePreferences`.

- [ ] **Step 1: `NotificationBell`.** Create `src/components/NotificationBell.jsx` — 60s poll per spec (no WebSockets/Durable Objects):

```javascript
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiClient } from '../api/client'

const POLL_MS = 60_000

export default function NotificationBell() {
  const api = useApiClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const boxRef = useRef(null)

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await api.listNotifications({ unread: '1', limit: '50' })
      setUnreadCount(data.notifications.length)
    } catch {
      // Silent — a failed poll shouldn't disrupt the rest of the UI.
    }
  }, [api])

  useEffect(() => {
    refreshUnreadCount()
    const id = setInterval(refreshUnreadCount, POLL_MS)
    return () => clearInterval(id)
  }, [refreshUnreadCount])

  useEffect(() => {
    if (!open) return
    api.listNotifications({ limit: '20' }).then((data) => setItems(data.notifications)).catch(() => {})
  }, [open, api])

  useEffect(() => {
    const onClickOutside = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const openItem = async (item) => {
    if (!item.read_at) {
      await api.markNotificationsRead({ ids: [item.id] })
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read_at: new Date().toISOString() } : i)))
      setUnreadCount((c) => Math.max(0, c - 1))
    }
    setOpen(false)
    if (item.link) navigate(item.link)
  }

  const markAllRead = async () => {
    await api.markNotificationsRead({ all: true })
    setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at || new Date().toISOString() })))
    setUnreadCount(0)
  }

  return (
    <div className="notification-bell" ref={boxRef}>
      <button className="notification-bell__trigger" onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        Bell{unreadCount > 0 && <span className="notification-bell__badge">{unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-bell__dropdown">
          <div className="notification-bell__header">
            <span>Notifications</span>
            <button className="link-btn" onClick={markAllRead}>Mark all read</button>
          </div>
          {items.length === 0 ? (
            <div className="notification-bell__empty">No notifications.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`notification-bell__item ${item.read_at ? '' : 'notification-bell__item--unread'}`}
                onClick={() => openItem(item)}
              >
                <div className="notification-bell__title">{item.title}</div>
                <div className="notification-bell__time mono">{new Date(item.created_at).toLocaleString()}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
```

  (`Bell` is a text placeholder — swap for whatever icon convention the rest of the topnav uses, e.g. an SVG or the same icon-font pattern as `sidebar-toggle`'s "Menu"/"Close" text buttons; this codebase currently uses plain text labels rather than an icon library, so a text/emoji glyph consistent with that is fine — don't introduce a new icon dependency for one button.)

- [ ] **Step 2: Mount in `PortalLayout.jsx`.** Import `NotificationBell` and add it inside `.topnav__user` (~line 93), before the username span:

```javascript
          <div className="topnav__user">
            <NotificationBell />
            <span className="topnav__username mono">{user?.username || user?.firstName || 'User'}</span>
            <UserButton afterSignOutUrl="/login" />
          </div>
```

- [ ] **Step 3: Email preference radio group.** In `src/components/workspace/WorkspaceSettingsTab.jsx`, add (per Russ's explicit call in the spec — placed here even though `email_pref` is a global per-user column, not per-workspace; no user-settings page exists yet and one radio group didn't justify building one):

```javascript
import { useState } from 'react'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'
import { PRESET_COLORS } from '../../constants/palette'

export default function WorkspaceSettingsTab({ slug, workspace, onSaved }) {
  const api = useApiClient()
  const { d1User } = usePortalAuth()
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [emailPref, setEmailPref] = useState(d1User?.emailPref || 'all')
  const [saving, setSaving] = useState(false)
  const [prefSaving, setPrefSaving] = useState(false)
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

  const savePref = async (pref) => {
    setEmailPref(pref)
    setPrefSaving(true)
    try {
      await api.updatePreferences(pref)
    } catch {
      setMessage({ kind: 'err', text: 'Could not save email preference.' })
    } finally {
      setPrefSaving(false)
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

      <label className="label" style={{ marginTop: '1.5rem' }}>Email notifications (applies to your account, all workspaces)</label>
      <div className="settings-tab__radios">
        {[
          { value: 'all', label: 'All activity' },
          { value: 'mentions', label: 'Mentions only' },
          { value: 'none', label: 'None' },
        ].map((opt) => (
          <label key={opt.value} className="settings-tab__radio">
            <input
              type="radio"
              name="email_pref"
              checked={emailPref === opt.value}
              onChange={() => savePref(opt.value)}
              disabled={prefSaving}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify.** `npm run build` clean; `npx eslint src/` clean. Manually verify: bell shows unread count, clicking an item navigates and marks it read, "Mark all read" clears the badge, changing email preference persists (reload the page, `/api/me` reflects the new `emailPref`).
- [ ] **Step 5: Commit.**

```bash
git add src/components/NotificationBell.jsx src/layouts/PortalLayout.jsx src/components/workspace/WorkspaceSettingsTab.jsx
git commit -m "feat(portal): topnav notification bell with 60s poll, email preference radio on workspace settings"
```

---

### Task 11: Version bump, deploy

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Bump `"version": "0.4.0"` → `"version": "0.5.0"` in `portal-app/package.json`.
- [ ] **Step 2: Full verify.** `npm test` (all suites); `npm run lint`; `npm run build`; `cd worker && npx wrangler deploy --dry-run`.
- [ ] **Step 3: Commit.**

```bash
git add package.json
git commit -m "chore(portal): bump to v0.5.0 — Phase 3 comments, activity, notification center"
```

- [ ] **Step 4: Deploy ordering (Global Constraints — additive migration, no narrow-before-widen gate here).**
  1. `npm run migrate` (applies `007_comments_notifications.sql` against remote D1).
  2. `cd worker && npx wrangler deploy`.
  3. `cd .. && npm run build && npx wrangler pages deploy dist --project-name wsl-portal --branch main --commit-dirty=true` (confirm `portal-app/.env` is present in this checkout first).
- [ ] **Step 5: Live ceiling tests** (spec §5, post-deploy, same discipline as Phase 2):
  - A `client`-role member cannot edit or delete another member's comment (403).
  - A member with only `read` permission cannot post a comment (403 — posting is `wsWrite`).
  - A mention of a non-member username is a silent no-op (no inbox row, no email, no error).
  - Deleting a comment with replies leaves the replies visible under its `"[deleted]"` stub.
  - **Acceptance (from the plan/spec):** Russ comments on a file → Chris (pref `all`) sees bell badge + inbox entry + email; with pref `mentions`, a plain comment gives Chris the bell badge + inbox entry but no email, while `@cdepalma` gets him the email too; the Activity tab shows Phase 2's own recent events (now populated with `workspace_id`) plus the new comment events, with no `workspace.view` noise.

---

## Addendum (2026-07-22): compound cursor fix

Task 6 and Task 7 above shipped `handleListNotifications` and `handleGetActivity`
with a `created_at`-only pagination cursor. CodeRabbit flagged this on PR #29 as
a Major finding — `created_at` has only second-level precision, so a page
boundary falling inside a group of same-second rows silently drops the rest of
that group — and it was deferred out of that PR's scope. Fixed in
`docs/superpowers/plans/2026-07-22-activity-notification-cursor-fix.md`: both
endpoints now seek on `(created_at, id)` via `worker/src/pagination.js` and
return an opaque `next_cursor`; `ActivityTab.jsx` consumes it instead of
deriving a cursor from the last row's `created_at`. `NotificationBell.jsx` and
`api/client.js` needed no change — the bell never paginates, and the client's
`listActivity`/`listNotifications` methods are opaque passthroughs.
