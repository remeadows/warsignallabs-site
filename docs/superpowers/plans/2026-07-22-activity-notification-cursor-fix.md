# Activity/Notification Compound Cursor Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `created_at`-only pagination cursor on `GET /api/notifications` and `GET /api/workspaces/:slug/activity` with an opaque compound `(created_at, id)` seek cursor, so same-second rows on a page boundary are never silently skipped.

**Architecture:** A new pure-function module (`worker/src/pagination.js`) encodes/decodes an opaque `"<created_at>::<id>"` cursor string and builds the seek-pagination SQL fragment (`(created_at < ? OR (created_at = ? AND id < ?))`). Both handlers switch their `ORDER BY` to `created_at DESC, id DESC`, filter with that fragment instead of a bare `created_at < ?`, and return a `next_cursor` field the frontend treats as an opaque token instead of reading `created_at` off the last row itself.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest (node environment, no D1/miniflare binding — see Global Constraints), React.

## Global Constraints

- In scope: only `handleListNotifications` (`portal-app/worker/src/routes/me.js`) and `handleGetActivity` (`portal-app/worker/src/routes/workspaces.js`). No other Phase 3 endpoint needs this — comments listing isn't paginated at all. Do not touch it.
- The cursor is opaque to callers: the frontend passes whatever `next_cursor` it received back as `before` without parsing it.
- Preserve the existing `limit` validation verbatim in both handlers: `Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50`. This was itself a prior CodeRabbit/Codex fix (commit `a251de4`) — do not regress it.
- This repo's `vitest.config.js` runs `worker/src/**/*.test.js` in a plain `node` environment — no D1 binding, no miniflare/`vitest-pool-workers`, and no frontend component test harness exists (`src/` has zero `*.test.jsx` files, no testing-library dependency). Do not introduce new test infrastructure for this fix. Test the new cursor logic as pure functions; verify the D1-touching handlers via the existing convention instead — `npm test` + `npx eslint` + `wrangler deploy --dry-run`, plus a manual `wrangler dev` smoke check.
- Do not alter `worker/migrations/007_comments_notifications.sql` or its indexes — the fix is a query/response-shape change only, not a schema change.

## Current-state facts the tasks rely on (verified 2026-07-22 against `feat/portal-phase3-collab` @ `a251de4`)

- `notification_inbox.id` and `audit_log.id` are both `crypto.randomUUID()` strings (36-char UUIDs) — unique per row, safe as a secondary sort/seek key regardless of their lack of chronological meaning.
- `handleListNotifications` (`portal-app/worker/src/routes/me.js:31-49`) and `handleGetActivity` (`portal-app/worker/src/routes/workspaces.js:94-123`) currently filter with a bare `created_at < ?` and order by `created_at DESC` only.
- `ActivityTab.jsx` (`portal-app/src/components/workspace/ActivityTab.jsx:28-89`) derives its own cursor from `items[items.length - 1].created_at` and infers `hasMore` from `data.activity.length === 50` (a hardcoded magic number matching the default limit).
- `NotificationBell.jsx` never paginates — it only calls `api.listNotifications({unread:'1', limit:'50'})` for the badge count and `api.listNotifications({limit:'20'})` for the dropdown list. It never sends a `before` param and needs **no code change**; this is confirmed by inspection, not assumed.
- `api.listActivity` / `api.listNotifications` in `portal-app/src/api/client.js:188-193` are thin passthroughs (`params` object → `URLSearchParams`) — they need no change; a compound cursor string flows through them exactly like the old bare-timestamp one did.

## File Structure

- Create `portal-app/worker/src/pagination.js` — pure cursor encode/decode + seek-clause builder, shared by both handlers.
- Create `portal-app/worker/src/pagination.test.js` — unit tests for the above (the only new tests; no D1 harness exists to test the handlers themselves against).
- Modify `portal-app/worker/src/routes/me.js` — `handleListNotifications` uses the compound cursor, returns `next_cursor`.
- Modify `portal-app/worker/src/routes/workspaces.js` — `handleGetActivity` uses the compound cursor, returns `next_cursor`.
- Modify `portal-app/src/components/workspace/ActivityTab.jsx` — consumes `next_cursor` instead of deriving a cursor from the last row's `created_at`.
- Modify `docs/superpowers/plans/2026-07-21-portal-phase3-collab.md` — append a short addendum pointing at this plan (the original Task 6/7 code blocks stay as-written historical record; see Task 5).

---

### Task 1: Shared seek-cursor helper

**Files:**
- Create: `portal-app/worker/src/pagination.js`
- Test: `portal-app/worker/src/pagination.test.js`

**Interfaces:**
- Produces for Task 2 and Task 3: `encodeCursor({created_at, id})` → `string`; `decodeCursor(cursor: string)` → `{createdAt, id}` or `null` if malformed; `seekCondition(cursor: {createdAt, id}, columnPrefix = '')` → `{clause: string, params: [string, string, string]}`.

- [ ] **Step 1: Write the failing tests**

```javascript
// portal-app/worker/src/pagination.test.js
import { describe, it, expect } from 'vitest'
import { encodeCursor, decodeCursor, seekCondition } from './pagination.js'

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a row with created_at and id', () => {
    const row = { created_at: '2026-07-22 10:15:30', id: 'ntf-abc123' }
    const cursor = encodeCursor(row)
    expect(decodeCursor(cursor)).toEqual({ createdAt: row.created_at, id: row.id })
  })

  it('returns null for a string with no delimiter', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })

  it('returns null when the created_at half is empty', () => {
    expect(decodeCursor('::ntf-abc123')).toBeNull()
  })

  it('returns null when the id half is empty', () => {
    expect(decodeCursor('2026-07-22 10:15:30::')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })
})

describe('seekCondition', () => {
  it('builds an unprefixed seek clause with matching bind params', () => {
    const cursor = { createdAt: '2026-07-22 10:15:30', id: 'ntf-abc123' }
    const { clause, params } = seekCondition(cursor)
    expect(clause).toBe('(created_at < ? OR (created_at = ? AND id < ?))')
    expect(params).toEqual(['2026-07-22 10:15:30', '2026-07-22 10:15:30', 'ntf-abc123'])
  })

  it('applies a column prefix to every comparison', () => {
    const cursor = { createdAt: '2026-07-22 10:15:30', id: 'aud-xyz789' }
    const { clause } = seekCondition(cursor, 'a.')
    expect(clause).toBe('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd portal-app && npx vitest run worker/src/pagination.test.js`
Expected: FAIL — `Cannot find module './pagination.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```javascript
// portal-app/worker/src/pagination.js
// Opaque seek-pagination cursor combining created_at with the row's unique id.
// created_at has only second-level precision (SQLite datetime('now')), so
// multiple rows can share a timestamp; a created_at-only cursor silently
// drops same-second rows that fall on a page boundary. Seeking on the pair
// keeps page boundaries exact no matter how many rows share a timestamp.

const DELIMITER = '::'

export function encodeCursor(row) {
  return `${row.created_at}${DELIMITER}${row.id}`
}

export function decodeCursor(cursor) {
  const idx = cursor.lastIndexOf(DELIMITER)
  if (idx === -1) return null
  const createdAt = cursor.slice(0, idx)
  const id = cursor.slice(idx + DELIMITER.length)
  if (!createdAt || !id) return null
  return { createdAt, id }
}

/** Seek-pagination WHERE fragment + bindings for `ORDER BY created_at DESC, id DESC`. */
export function seekCondition(cursor, columnPrefix = '') {
  return {
    clause: `(${columnPrefix}created_at < ? OR (${columnPrefix}created_at = ? AND ${columnPrefix}id < ?))`,
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd portal-app && npx vitest run worker/src/pagination.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add portal-app/worker/src/pagination.js portal-app/worker/src/pagination.test.js
git commit -m "feat(portal): add compound (created_at, id) seek-cursor helper"
```

---

### Task 2: `handleListNotifications` uses the compound cursor

**Files:**
- Modify: `portal-app/worker/src/routes/me.js:1-2` (import), `portal-app/worker/src/routes/me.js:30-49` (`handleListNotifications`)

**Interfaces:**
- Consumes: `encodeCursor`, `decodeCursor`, `seekCondition` from Task 1.
- Produces for Task 4: `GET /api/notifications` response shape gains `next_cursor: string | null` alongside the existing `notifications` array.

- [ ] **Step 1: Update the import**

In `portal-app/worker/src/routes/me.js`, change:

```javascript
import { jsonResponse, errorResponse } from '../cors.js'
```

to:

```javascript
import { jsonResponse, errorResponse } from '../cors.js'
import { encodeCursor, decodeCursor, seekCondition } from '../pagination.js'
```

- [ ] **Step 2: Replace `handleListNotifications`**

Replace the existing function (lines 30-49) with:

```javascript
/** GET /api/notifications?unread=1&limit=50&before= — self */
export async function handleListNotifications(request, env, user) {
  const url = new URL(request.url)
  const unreadOnly = url.searchParams.get('unread') === '1'
  const rawLimit = parseInt(url.searchParams.get('limit'), 10)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const before = url.searchParams.get('before')

  const conditions = ['user_id = ?']
  const bindings = [user.dbUserId || user.userId]
  if (unreadOnly) conditions.push('read_at IS NULL')
  if (before) {
    const cursor = decodeCursor(before)
    if (!cursor) return errorResponse('Invalid before cursor', 400)
    const { clause, params } = seekCondition(cursor)
    conditions.push(clause)
    bindings.push(...params)
  }

  const result = await env.DB.prepare(
    `SELECT id, event_type, title, body, link, read_at, created_at FROM notification_inbox
     WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...bindings, limit).all()

  const notifications = result.results
  const nextCursor = notifications.length === limit ? encodeCursor(notifications[notifications.length - 1]) : null

  return jsonResponse({ notifications, next_cursor: nextCursor })
}
```

- [ ] **Step 3: Verify**

Run: `cd portal-app && npm test && npx eslint worker/src/routes/me.js worker/src/pagination.js`
Expected: all suites pass, eslint clean.

Run: `cd portal-app/worker && npx wrangler deploy --dry-run`
Expected: bundles with no errors.

- [ ] **Step 4: Commit**

```bash
git add portal-app/worker/src/routes/me.js
git commit -m "fix(portal): compound seek cursor for notification list pagination"
```

---

### Task 3: `handleGetActivity` uses the compound cursor

**Files:**
- Modify: `portal-app/worker/src/routes/workspaces.js:1-3` (import), `portal-app/worker/src/routes/workspaces.js:94-123` (`handleGetActivity`)

**Interfaces:**
- Consumes: `encodeCursor`, `decodeCursor`, `seekCondition` from Task 1.
- Produces for Task 4: `GET /api/workspaces/:slug/activity` response shape gains `next_cursor: string | null` alongside the existing `activity` array.

- [ ] **Step 1: Update the import**

In `portal-app/worker/src/routes/workspaces.js`, change:

```javascript
import { jsonResponse, errorResponse } from '../cors.js'
import { requireRole, requireWorkspaceAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
```

to:

```javascript
import { jsonResponse, errorResponse } from '../cors.js'
import { requireRole, requireWorkspaceAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { encodeCursor, decodeCursor, seekCondition } from '../pagination.js'
```

- [ ] **Step 2: Replace `handleGetActivity`**

Replace the existing function (lines 94-123) with:

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
  const rawLimit = parseInt(url.searchParams.get('limit'), 10)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const before = url.searchParams.get('before')

  const conditions = ['a.workspace_id = ?', "a.action != 'workspace.view'"]
  const bindings = [workspace.id]
  if (before) {
    const cursor = decodeCursor(before)
    if (!cursor) return errorResponse('Invalid before cursor', 400)
    const { clause, params: cursorParams } = seekCondition(cursor, 'a.')
    conditions.push(clause)
    bindings.push(...cursorParams)
  }

  const result = await env.DB.prepare(
    `SELECT a.id, a.action, a.resource_type, a.resource_id, a.metadata_json, a.created_at,
            u.username AS actor_username
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id OR u.clerk_id = a.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
  ).bind(...bindings, limit).all()

  const activity = result.results.map((r) => ({
    ...r,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : {},
  }))
  const nextCursor = activity.length === limit ? encodeCursor(activity[activity.length - 1]) : null

  return jsonResponse({ activity, next_cursor: nextCursor })
}
```

Note the destructure renames `seekCondition`'s `params` to `cursorParams` — `handleGetActivity`'s own 4th argument is already named `params` (the route params object with `.slug`); do not shadow it.

- [ ] **Step 3: Verify**

Run: `cd portal-app && npm test && npx eslint worker/src/routes/workspaces.js`
Expected: all suites pass, eslint clean.

Run: `cd portal-app/worker && npx wrangler deploy --dry-run`
Expected: bundles with no errors.

- [ ] **Step 4: Commit**

```bash
git add portal-app/worker/src/routes/workspaces.js
git commit -m "fix(portal): compound seek cursor for workspace activity pagination"
```

---

### Task 4: `ActivityTab.jsx` consumes `next_cursor`

**Files:**
- Modify: `portal-app/src/components/workspace/ActivityTab.jsx:28-89`

**Interfaces:**
- Consumes: `next_cursor` field from Task 3's `GET /api/workspaces/:slug/activity` response.

- [ ] **Step 1: Replace the component body**

Replace lines 28-89 (everything from `export default function ActivityTab` to the closing `}`) with:

```jsx
export default function ActivityTab({ slug }) {
  const api = useApiClient()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cursor, setCursor] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async (before) => {
    const data = await api.listActivity(slug, before ? { before } : {})
    setCursor(data.next_cursor)
    return data.activity
  }, [api, slug])

  useEffect(() => {
    setLoading(true)
    load()
      .then((data) => { setItems(data); setError(null) })
      .catch(() => setError('Could not load activity.'))
      .finally(() => setLoading(false))
  }, [load])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const more = await load(cursor)
      setItems((prev) => [...prev, ...more])
      setError(null)
    } catch {
      setError('Could not load more activity.')
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) return <div className="activity-tab__loading"><div className="spinner" /></div>

  return (
    <div className="activity-tab">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
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
      {cursor && items.length > 0 && (
        <button className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
```

This drops the old `hasMore` state (which inferred "more pages" from `data.activity.length === 50`, a magic number tied to the default limit) in favor of `cursor` itself: `next_cursor` is `null` exactly when the server has no more rows, and truthy otherwise. `loadMore` now guards on `!cursor` instead of `items.length === 0`, and passes the opaque cursor token straight through instead of reading `created_at` off the last item.

- [ ] **Step 2: Verify**

Run: `cd portal-app && npm run build && npx eslint src/components/workspace/ActivityTab.jsx`
Expected: build clean, eslint clean.

Manual check (dev server, per this repo's convention of manual live checks for UI — no component test harness exists): open a workspace's Activity tab, confirm the list loads, confirm "Load more" appears only when `next_cursor` is non-null and fetches the next page without repeating or skipping rows. If you can seed 3+ audit_log rows with an identical `created_at` (e.g. via a quick script or by triggering several rapid actions) straddling a page boundary at `limit=2`, confirm all rows still appear across the two pages — this is the exact scenario the old cursor dropped.

- [ ] **Step 3: Commit**

```bash
git add portal-app/src/components/workspace/ActivityTab.jsx
git commit -m "fix(portal): ActivityTab paginates on opaque next_cursor, not last row's created_at"
```

---

### Task 5: Point the Phase 3 plan at this fix

**Files:**
- Modify: `docs/superpowers/plans/2026-07-21-portal-phase3-collab.md` (append only, after the existing Task 11 section — do not edit the historical Task 6/7 code blocks, which document what actually shipped in PR #29)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Append an addendum**

At the end of `docs/superpowers/plans/2026-07-21-portal-phase3-collab.md` (after the last line of Task 11's live-ceiling-tests bullet list), add:

```markdown

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
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-07-21-portal-phase3-collab.md
git commit -m "docs(portal): point Phase 3 plan at the compound-cursor follow-up fix"
```
