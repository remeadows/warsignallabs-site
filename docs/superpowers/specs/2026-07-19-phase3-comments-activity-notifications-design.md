# Phase 3 — Comments, Activity, Notification Center: Design

**Status:** Approved by Russ 2026-07-19. Source of truth for scope/behavior is
`portal-app/PORTAL_OVERHAUL_PLAN.md` §3.2.4/§3.5 and the Phase 3 execution section
(§4). This document captures the wiring-level decisions the plan states as outcomes
but doesn't spell out mechanically, plus a handful of choices made during design that
depart from or sharpen the original 2026-07-17 sketch.

## Scope

Phase 3 = exactly: comments (workspace discussion + per-file comments) → activity feed
(workspace-scoped `audit_log`) → in-app notification center (bell, inbox, email
preferences). All three ship together in one PR (v0.5.0), matching how Phase 1 and
Phase 2 each shipped as one coherent, demoable unit — they're genuinely interdependent
here: comments feed the inbox, the inbox needs `email_pref`, and the plan's own
acceptance criterion touches all three at once.

**Not in scope** (Phase 4 per the plan's phased execution section): projects, tasks,
task-assignment events, Home redesign. The `comments.entity_type` CHECK constraint
does include `'task'` now (see §1) as prep for Phase 4, but no task-commenting code
ships this phase.

## 1. Schema — `003_comments_notifications.sql`

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,               -- cmt-<nanoid>
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
  id TEXT PRIMARY KEY,               -- ntf-<nanoid>
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

Design decisions (deviations from / sharpenings of the original 2026-07-17 sketch):

- **`entity_type` includes `'task'` now**, even though Phase 4 hasn't shipped tasks
  yet. This session hit a real production incident (during Phase 2 acceptance
  testing) from widening a `CHECK` constraint after a table already had live data —
  SQLite/D1 requires a full rename-and-rebuild to alter a `CHECK`, which has sharp,
  D1-specific edges (a table rename silently retargets *other* tables' FK schema
  text — not reproducible in local `sqlite3` testing). Locking in `'task'` while
  `comments` is brand new and empty avoids repeating that rebuild in Phase 4.
- **`notification_inbox` is a new, separate table from the existing `notifications`
  table.** `notifications` (Phase 1) stays the email-send log — Resend delivery
  status, `resend_id`, sent/failed. `notification_inbox` is purely in-app
  read/unread bell state. Different lifecycle, different consumer, no shared rows.
- **`email_pref` and it's `CHECK`** — the original plan's comment said "all |
  mentions | none" in prose but didn't constrain it in SQL. Same lesson as this
  session's `users.status` incident: constrain enum-like columns at the DB level
  from day one, not just at the application layer.
- **Both `ALTER TABLE ADD COLUMN` statements are additive-only** — no rename, no
  rebuild, none of the D1 sharp edges above apply to them.
- **`audit_log.workspace_id`** exists so the Activity feed can be a single indexed
  query (`WHERE workspace_id = ?`) instead of resolving workspace scope per-row from
  `resource_id` at read time (unreliable — several existing event types, e.g.
  `user.create`, have no workspace at all).

## 2. Worker API

```
# Comments
GET    /api/workspaces/:slug/comments?entity_type=&entity_id=   (member)
POST   /api/workspaces/:slug/comments                            (wsWrite)  body: {entity_type, entity_id, parent_comment_id?, body}
PATCH  /api/comments/:id                                          (author only)  body: {body}  -- sets edited_at
DELETE /api/comments/:id                                          (author, wsAdmin, or global admin — soft delete only)

# Notifications
GET    /api/notifications?unread=1&limit=50&before=                (self)  -- unread=1 filters; limit/before paginate same as activity
POST   /api/notifications/mark-read                                (self)  body: {ids: [...]} or {all: true}
PATCH  /api/me/preferences                                         (self)  body: {email_pref}

# Activity
GET    /api/workspaces/:slug/activity?limit=50&before=            (member)  -- audit_log scoped to workspace_id
```

Ceilings, extending the Phase 2 pattern (`requireWorkspaceAccess`, `hasWorkspaceAdminPermission`):

- **Read** (`comments`, `activity`): any workspace member.
- **Create** (`comments`): `wsWrite` — write or admin permission on that workspace, or global admin.
- **Edit**: author only, and only while `deleted_at IS NULL` — editing an
  already-deleted comment returns 404 (it no longer exists as far as the API is
  concerned). Not even `wsAdmin` may alter someone else's words. A denied attempt
  writes a `comment.edit.denied` audit row (pattern from Phase 2's `member.*.denied`
  events).
- **Delete**: author, `wsAdmin`, or global admin. Always soft delete
  (`deleted_at`) — the API never issues a hard `DELETE FROM comments`.
- **Replies are exactly one level deep, enforced by rejection, not flattening**: a
  `POST` whose `parent_comment_id` itself has a non-null `parent_comment_id` returns
  400 (`"Cannot reply to a reply"`), rather than silently re-parenting it to the
  top-level comment. The client only ever offers a reply action on top-level
  comments, so this should never be user-reachable in normal use — it's a
  server-side backstop, not a UX path.
- **Mentions**: parsed server-side from the submitted body against *that
  workspace's* member usernames only — no cross-workspace leakage. A match that
  isn't actually a member of the workspace is silently ignored (not an error).

**`logAudit` signature change:** adds an optional `workspaceId` to the existing
`details` object rather than a new required positional parameter — a call site that
omits it simply leaves the column `NULL`. This is backward-compatible, so it doesn't
require an atomic sweep of all ~27 existing call sites. Every call site that already
has a `workspace.id` in scope (files, folders, members, workspaces routes, and the
new comments code) gets updated to pass it, since that's most of the 27 and is what
actually populates the Activity feed. Genuinely global events (`user.create`,
`user.role.change`, `user.deactivate`/`activate`, `workspace.create`/`delete` itself)
correctly leave it `NULL`.

## 3. Frontend

**Shared `CommentThread` component** (`src/components/CommentThread.jsx`) — takes
`{workspaceSlug, entityType, entityId}`; renders the list (author, timestamp, body,
one level of replies, `"[deleted]"` stubs for soft-deleted comments) plus a composer
with `@mention` autocomplete (a filtered dropdown against that workspace's member
list, fetched once per mount — small member counts make this cheap). Two mount
points, same component:

- **Discussion tab** on `WorkspaceDetail.jsx` (new tab alongside Files/Members/
  Settings) — `entityType='workspace'`, `entityId=workspace.id`.
- **File comment panel** — a slide-over triggered by a new "Comments" action on each
  file row in the folder browser — `entityType='file'`, `entityId=file.id`.

**Activity tab** — also on `WorkspaceDetail.jsx`, alongside Discussion. Paginated
(`limit`/`before` cursor) read-only list of that workspace's `audit_log` rows:
uploads, permission changes, invitations, comments, etc.

**Topnav bell** (`PortalLayout.jsx`, in `.topnav__user`) — unread badge from
`GET /api/notifications?unread=1`, polled every 60s (no WebSockets/Durable
Objects — matches the plan's explicit "refetch + 60s poll is indistinguishable from
real-time at this scale" decision). Click opens a dropdown of recent inbox rows
(title, relative time, a link to `notification.link`), individually markable read,
plus a "Mark all read" action (`POST /api/notifications/mark-read {all: true}`).

**Email preference** — a radio group (`All activity` / `Mentions only` / `None`)
wired to `PATCH /api/me/preferences`, placed on the **workspace Settings tab** next
to the existing rename/color controls, per Russ's explicit call — even though
`email_pref` is a global per-user column, not per-workspace. (Noted as an
intentional placement choice, not an oversight: no user-level settings page exists
yet, and adding one wasn't judged worth it for a single radio group.)

**Comment body rendering:** plain text only, no markdown. Line breaks preserved,
`@mentions` highlighted. No new rendering/escaping surface beyond what's already
handled for names/emails elsewhere in the portal.

## 4. Notification event wiring

New event types on the existing `notifyWorkspaceEvent` pattern (`worker/src/
notify.js`): `comment.create`, `comment.mention` — joining Phase 2's `member.invite`,
`member.join`, `member.permission_change`.

Every workspace-scoped mutation that calls `notifyWorkspaceEvent` now does two
things instead of one:

1. **Inbox row** — written for each recipient unconditionally. The bell should
   reflect everything relevant regardless of email settings; email is opt-out, the
   inbox isn't.
2. **Email** — same recipient resolution as today (admins always; workspace
   members; actor excluded), now filtered by each recipient's `email_pref`: `all`
   gets every email as today; `mentions` only gets `comment.mention` emails (all
   other event types are skipped for that user); `none` gets nothing. This filter
   applies to the email leg only, never to the inbox row.

`comment.mention` recipients are resolved separately from "all workspace members" —
they come from the parsed `@username` matches, not the general recipient list.

Acceptance example (from the plan, unchanged): Russ comments on a file → Chris
(pref `all`) sees bell badge + inbox entry + email. If Chris's pref were `mentions`,
a plain (non-`@cdepalma`) comment still gives him the bell badge + inbox entry, just
no email; `@cdepalma` gets him the email too.

## 5. Testing, ceilings, rollout

**Unit tests** (Vitest): mention-parsing helper (extract `@username` matches
against a member list), the `email_pref` × event-type email filter, and the
edit/delete authorization checks (author vs. `wsAdmin` vs. neither) as small pure
functions in `auth.js`, mirroring `hasWorkspaceAdminPermission`/
`memberChangeViolation`.

**Live ceiling tests** (post-deploy, same discipline as Phase 2): a `client`-role
member cannot edit or delete another member's comment (403); a member with only
`read` permission cannot post a comment (403 — posting is `wsWrite`); a mention of a
non-member username is a silent no-op (no inbox row, no email, no error); deleting a
comment with replies leaves the replies visible under its `"[deleted]"` stub.

**Rollout ordering:** migration `003_comments_notifications.sql` first — unlike
Phase 2, there's no "narrow authz before widening data" sequencing constraint here,
since everything in this migration is additive (new tables + `ADD COLUMN`s, no
promotion-style data mutation). Then Worker deploy, then frontend deploy. Version
bump to `0.5.0`.

**Acceptance** (from the plan): Russ comments on a file → Chris sees bell badge +
inbox entry + email (pref `all`); with pref `mentions`, plain comments email
nothing but `@cdepalma` does; deleting a comment leaves a `"[deleted]"` stub with
replies intact; the Activity tab shows Phase 2's own recent events (member invites/
permission changes, now that `workspace_id` is populated) plus the new comment
events.
