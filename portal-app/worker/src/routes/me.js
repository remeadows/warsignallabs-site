// worker/src/routes/me.js
import { jsonResponse, errorResponse } from '../cors.js'
import { encodeCursor, decodeCursor, seekCondition } from '../pagination.js'

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

/** POST /api/notifications/mark-read — self. Body: {ids: [...]} or {all: true} */
export async function handleMarkNotificationsRead(request, env, user) {
  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('JSON object body is required', 400)
  }

  const userId = user.dbUserId || user.userId
  if (body.all === true) {
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('JSON object body is required', 400)
  }

  const { email_pref: emailPref } = body
  if (!['all', 'mentions', 'none'].includes(emailPref)) {
    return errorResponse('email_pref must be one of: all, mentions, none', 400)
  }

  await env.DB.prepare(`UPDATE users SET email_pref = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(emailPref, user.dbUserId || user.userId).run()

  return jsonResponse({ message: 'Preferences updated', email_pref: emailPref })
}

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

  // projects join: paused/archived projects' tasks stay included (spec §2 —
  // no status filter), but tasks under a soft-DELETED project must not
  // surface here; their deep links point into a project that no longer lists.
  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.status, t.due_date, t.project_id,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM tasks t
     INNER JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
     INNER JOIN workspaces w ON w.id = t.workspace_id
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
