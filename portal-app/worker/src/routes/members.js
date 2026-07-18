// worker/src/routes/members.js
// Workspace membership + invitations (Phase 2). All ceilings enforced here
// server-side via the pure helpers in ../auth.js — UI hiding is not enforcement.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceAdminPermission, memberChangeViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'

export async function getWorkspaceBySlug(env, slug) {
  return env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE slug = ?')
    .bind(slug).first()
}

async function adminPermissionCount(env, workspaceId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_workspaces WHERE workspace_id = ? AND permission = 'admin'`,
  ).bind(workspaceId).first()
  return row?.cnt || 0
}

/** GET /api/workspaces/:slug/members — any member */
export async function handleListMembers(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE uw.workspace_id = ? ORDER BY u.username`,
  ).bind(workspace.id).all()

  return jsonResponse({ members: result.results })
}

/** PATCH /api/workspaces/:slug/members/:userId — wsAdmin. Body: {permission} */
export async function handleUpdateMemberPermission(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const { permission } = body
  if (!['read', 'write', 'admin'].includes(permission)) {
    return errorResponse("permission must be one of: read, write, admin", 400)
  }

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)
  if (target.permission === permission) {
    return jsonResponse({ message: 'No change', permission })
  }

  // Ceiling: never a global admin; never zero out the last admin-permission member.
  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' && permission !== 'admin'
    ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.permission_change.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, attempted: permission, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('UPDATE user_workspaces SET permission = ? WHERE id = ?')
    .bind(permission, target.uw_id).run()

  await logAudit(env, user.userId, 'member.permission_change', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, from: target.permission, to: permission,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Permission updated', permission })
}

/** DELETE /api/workspaces/:slug/members/:userId — wsAdmin */
export async function handleRemoveMember(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)

  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.remove.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('DELETE FROM user_workspaces WHERE id = ?').bind(target.uw_id).run()

  await logAudit(env, user.userId, 'member.remove', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, username: target.username,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Member removed' })
}
