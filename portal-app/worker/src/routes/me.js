// worker/src/routes/me.js
import { jsonResponse, errorResponse } from '../cors.js'

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
