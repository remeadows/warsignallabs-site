// worker/src/routes/users.js
import { jsonResponse, errorResponse } from '../cors.js'
import { requireRole } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent } from '../notify.js'

/**
 * GET /api/users — admin/owner, lists all users from D1
 */
export async function handleListUsers(request, env, user) {
  requireRole(user, 'admin')

  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status, u.created_at,
            COUNT(uw.id) AS workspace_count
     FROM users u
     LEFT JOIN user_workspaces uw ON uw.user_id = u.id
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all()

  const countResult = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first()

  return jsonResponse({
    users: result.results,
    pagination: {
      total: countResult?.total || 0,
      limit,
      offset,
    },
  })
}

/**
 * POST /api/users — admin only, create a new user in D1
 * Body: { username, email, role }
 */
export async function handleCreateUser(request, env, user, ctx) {
  requireRole(user, 'admin')

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { username, email, role: newRole } = body
  if (!username || !email) return errorResponse('username and email are required', 400)

  const validRoles = ['admin', 'owner', 'client']
  if (newRole && !validRoles.includes(newRole)) {
    return errorResponse(`role must be one of: ${validRoles.join(', ')}`, 400)
  }

  // Check uniqueness
  const existingUser = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username).first()
  if (existingUser) return errorResponse('Username already exists', 409)

  const existingEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email).first()
  if (existingEmail) return errorResponse('Email already exists', 409)

  const userId = `usr-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
  ).bind(userId, username, email, newRole || 'client').run()

  await logAudit(env, user.userId, 'user.create', {
    resourceType: 'user', resourceId: userId,
    username, email, role: newRole || 'client',
    ipAddress: getClientIp(request),
  })

  // Notify admins of new user creation
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'user.create',
    workspaceId: null,
    workspaceName: null,
    title: `New User Created: ${username}`,
    bodyLines: [
      `<strong>Username:</strong> ${username}`,
      `<strong>Email:</strong> ${email}`,
      `<strong>Role:</strong> ${newRole || 'client'}`,
      `<strong>Created by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { userId, username, email, role: newRole || 'client' },
  })

  return jsonResponse({
    user: { id: userId, username, email, role: newRole || 'client', status: 'active' },
    message: 'User created',
  }, 201)
}

/**
 * PATCH /api/users/:id/role — admin only, change user role
 * Body: { role: 'admin' | 'owner' | 'client' }
 */
export async function handleChangeRole(request, env, user, params) {
  requireRole(user, 'admin')
  const targetId = params.id

  const target = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(targetId).first()
  if (!target) return errorResponse('User not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { role: newRole } = body
  const validRoles = ['admin', 'owner', 'client']
  if (!newRole || !validRoles.includes(newRole)) {
    return errorResponse(`role must be one of: ${validRoles.join(', ')}`, 400)
  }

  await env.DB.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newRole, targetId).run()

  await logAudit(env, user.userId, 'user.role.change', {
    resourceType: 'user', resourceId: targetId,
    username: target.username,
    oldRole: target.role, newRole,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Role updated', userId: targetId, role: newRole })
}

/**
 * POST /api/users/:id/deactivate — admin/owner only
 */
export async function handleDeactivateUser(request, env, user, params) {
  requireRole(user, 'admin')
  const targetId = params.id

  const target = await env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(targetId).first()
  if (!target) return errorResponse('User not found', 404)
  if (target.role === 'admin' && user.role !== 'admin') {
    return errorResponse('Only admins can deactivate other admins', 403)
  }

  await env.DB.prepare("UPDATE users SET status = 'inactive', updated_at = datetime('now') WHERE id = ?")
    .bind(targetId).run()

  await logAudit(env, user.userId, 'user.deactivate', {
    resourceType: 'user', resourceId: targetId,
    username: target.username, ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'User deactivated', userId: targetId })
}

/**
 * POST /api/users/:id/activate — admin/owner only
 */
export async function handleActivateUser(request, env, user, params) {
  requireRole(user, 'admin')
  const targetId = params.id

  const target = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
    .bind(targetId).first()
  if (!target) return errorResponse('User not found', 404)

  await env.DB.prepare("UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?")
    .bind(targetId).run()

  await logAudit(env, user.userId, 'user.activate', {
    resourceType: 'user', resourceId: targetId,
    username: target.username, ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'User activated', userId: targetId })
}
