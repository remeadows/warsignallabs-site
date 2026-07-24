// worker/src/routes/workspaces.js
import { jsonResponse, errorResponse } from '../cors.js'
import { requireRole, requireWorkspaceAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { encodeCursor, decodeCursor, seekCondition } from '../pagination.js'

/**
 * GET /api/workspaces — returns workspaces filtered by user access
 */
export async function handleListWorkspaces(request, env, user) {
  let workspaces

  if (user.role === 'admin') {
    const result = await env.DB.prepare(
      'SELECT id, name, slug, color, created_at FROM workspaces ORDER BY name',
    ).all()
    workspaces = result.results
  } else {
    // Owner/client: filter by workspace_slugs from auth
    if (user.workspaceSlugs.length === 0) {
      return jsonResponse({ workspaces: [] })
    }
    const placeholders = user.workspaceSlugs.map(() => '?').join(', ')
    const result = await env.DB.prepare(
      `SELECT id, name, slug, color, created_at
       FROM workspaces
       WHERE slug IN (${placeholders})
       ORDER BY name`,
    )
      .bind(...user.workspaceSlugs)
      .all()
    workspaces = result.results
  }

  return jsonResponse({ workspaces })
}

/**
 * GET /api/workspaces/:slug — returns a single workspace with access check
 */
export async function handleGetWorkspace(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)

  const workspace = await env.DB.prepare(
    'SELECT id, name, slug, color, created_at FROM workspaces WHERE slug = ?',
  )
    .bind(params.slug)
    .first()

  if (!workspace) {
    return errorResponse('Workspace not found', 404)
  }

  const memberCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM user_workspaces WHERE workspace_id = ?',
  )
    .bind(workspace.id)
    .first()

  const fileCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM files WHERE workspace_id = ?',
  )
    .bind(workspace.id)
    .first()

  await logAudit(env, user.userId, 'workspace.view', {
    resourceType: 'workspace',
    resourceId: workspace.id,
    workspaceId: workspace.id,
    workspaceSlug: params.slug,
    ipAddress: getClientIp(request),
  })

  // Determine current user's effective permission on this workspace
  const userPermission = user.role === 'admin'
    ? 'admin'
    : (user.workspacePermissions || {})[params.slug] || 'read'

  return jsonResponse({
    workspace: {
      ...workspace,
      memberCount: memberCount?.count || 0,
      fileCount: fileCount?.count || 0,
      userPermission,
    },
  })
}

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

/**
 * POST /api/workspaces — create a new workspace (admin or owner)
 */
export async function handleCreateWorkspace(request, env, user) {
  requireRole(user, 'admin', 'owner')

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { name, slug, color } = body
  if (!name || !slug) return errorResponse('name and slug are required', 400)

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse('slug must be lowercase alphanumeric with hyphens only', 400)
  }

  const existing = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?')
    .bind(slug).first()
  if (existing) return errorResponse('A workspace with this slug already exists', 409)

  const wsColor = color || '#6F8FB8'
  const wsId = crypto.randomUUID()

  // Creator becomes an admin-permission member (§3.2.1). Global admins get the
  // row too — harmless, and it keeps the "last admin-permission member" guard
  // meaningful from day one. Atomic: a failure on the membership insert must
  // not leave an orphaned workspace with no admin-permission member.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, slug, color, storage_quota_mb, storage_used_mb, created_at, updated_at)
       VALUES (?, ?, ?, ?, 2048, 0, datetime('now'), datetime('now'))`,
    ).bind(wsId, name, slug, wsColor),
    env.DB.prepare(
      `INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
       VALUES (?, ?, ?, 'admin', datetime('now'))`,
    ).bind(crypto.randomUUID(), user.dbUserId, wsId),
  ])

  await logAudit(env, user.userId, 'workspace.create', {
    resourceType: 'workspace', resourceId: wsId,
    name, slug, ipAddress: getClientIp(request),
  })

  return jsonResponse({ workspace: { id: wsId, name, slug, color: wsColor } }, 201)
}

/**
 * PATCH /api/workspaces/:slug — update workspace (workspace admin permission or global admin)
 */
export async function handleUpdateWorkspace(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }

  const workspace = await env.DB.prepare('SELECT id, name, slug, color FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  // Storage quota is infrastructure, not workspace settings (§3.1 grants
  // wsAdmin "rename workspace, workspace settings" only).
  if (body.storage_quota_mb && user.role !== 'admin') {
    return errorResponse('Forbidden: only a global admin can change storage quota', 403)
  }

  const updates = []
  const bindings = []

  if (body.name) { updates.push('name = ?'); bindings.push(body.name) }
  if (body.color) { updates.push('color = ?'); bindings.push(body.color) }
  if (body.storage_quota_mb) { updates.push('storage_quota_mb = ?'); bindings.push(body.storage_quota_mb) }

  if (updates.length === 0) return errorResponse('No fields to update', 400)

  updates.push("updated_at = datetime('now')")
  bindings.push(workspace.id)

  await env.DB.prepare(
    `UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`,
  ).bind(...bindings).run()

  await logAudit(env, user.userId, 'workspace.update', {
    resourceType: 'workspace', resourceId: workspace.id,
    workspaceId: workspace.id,
    slug: params.slug, changes: Object.keys(body),
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace updated', slug: params.slug })
}

/**
 * Fast-path guard against a write racing an in-flight workspace deletion.
 * This reads a previously-fetched `workspace`/`file` row, so it rejects the
 * common case (a workspace already known to be locked) cheaply and early —
 * it is NOT the correctness guarantee for the actual race, since the object
 * it checks can go stale between this call and a later write. The atomic
 * guarded writes in handleDeleteWorkspace/handleUploadFile/handleReplaceFile
 * are what close the race itself (ADR-0005).
 */
export function assertWorkspaceNotDeleting(workspace) {
  if (workspace?.deleting_at) {
    throw errorResponse('Workspace is being deleted', 409)
  }
}

/**
 * DELETE /api/workspaces/:slug — admin only, deletes workspace + files + assignments
 */
export async function handleDeleteWorkspace(request, env, user, params) {
  requireRole(user, 'admin')

  const workspace = await env.DB.prepare('SELECT id, name, slug, deleting_at FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)
  assertWorkspaceNotDeleting(workspace)

  // Claim the deletion lock atomically: the WHERE clause re-checks
  // deleting_at at write time, not at the time `workspace` above was read.
  // Two concurrent deletes can both pass the fast-path check above (both
  // read deleting_at = NULL before either writes) — this conditional UPDATE
  // is what actually closes the race, since SQLite serializes statement
  // execution and only one caller's UPDATE can still match a row where
  // deleting_at IS NULL (ADR-0005).
  const lockResult = await env.DB.prepare(
    "UPDATE workspaces SET deleting_at = datetime('now') WHERE id = ? AND deleting_at IS NULL",
  ).bind(workspace.id).run()
  if (lockResult.meta.changes === 0) {
    return errorResponse('Workspace is being deleted', 409)
  }

  try {
    // Delete files from R2. Aggregate failures instead of swallowing them —
    // if any R2 object can't be deleted, the D1 batch below must not run, or
    // the only record of that R2 key would be removed while the object
    // itself still exists, orphaning it the same way the upload/replace race
    // does (ADR-0005).
    const files = await env.DB.prepare('SELECT r2_key FROM files WHERE workspace_id = ?')
      .bind(workspace.id).all()
    const r2Failures = []
    for (const f of files.results) {
      try {
        await env.FILES.delete(f.r2_key)
      } catch (err) {
        r2Failures.push({ r2_key: f.r2_key, error: err.message })
      }
    }
    if (r2Failures.length > 0) {
      throw new Error(`Failed to delete ${r2Failures.length} R2 object(s): ${r2Failures.map((f) => f.r2_key).join(', ')}`)
    }

    // Delete D1 records: files, comments, invitations, user_workspaces, then
    // detach notifications, then delete the workspace. Each of these FKs has no
    // cascade (ADR-0004), so a workspace with any comment, invitation, or email
    // history would otherwise fail this delete with a foreign-key error.
    // notifications (the Phase 1 email send log) is detached, not deleted — the
    // send history must survive workspace deletion, same reasoning as
    // audit_log.workspace_id ON DELETE SET NULL (ADR-0004).
    // One atomic batch: if any statement fails (e.g. an unhandled child-table
    // FK), nothing commits — sequential .run() calls would leave the send log
    // permanently detached from a workspace that still exists.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM files WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM comments WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM invitations WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM user_workspaces WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('UPDATE notifications SET workspace_id = NULL WHERE workspace_id = ?').bind(workspace.id),
      env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspace.id),
    ])
  } catch (err) {
    // The lock write above already committed outside this try block — a
    // failed R2 loop (including the aggregated-failure throw above) or a
    // failed batch must not leave the workspace permanently locked out of
    // future uploads (ADR-0005).
    await env.DB.prepare('UPDATE workspaces SET deleting_at = NULL WHERE id = ?')
      .bind(workspace.id).run()
    throw err
  }

  await logAudit(env, user.userId, 'workspace.delete', {
    resourceType: 'workspace', resourceId: workspace.id,
    name: workspace.name, slug: workspace.slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace deleted', slug: params.slug })
}

/**
 * GET /api/users/:id/workspaces — get workspace assignments for a user
 */
export async function handleGetUserWorkspaces(request, env, user, params) {
  requireRole(user, 'admin')
  const targetId = params.id

  const result = await env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.color, uw.permission
     FROM workspaces w
     INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
     WHERE uw.user_id = ?
     ORDER BY w.name`,
  ).bind(targetId).all()

  return jsonResponse({ workspaces: result.results })
}

/**
 * PATCH /api/users/:id/workspaces — update workspace assignments
 * Body: { assignments: [{ workspace_id, permission }] }
 * Replaces all assignments for the user.
 */
export async function handleUpdateUserWorkspaces(request, env, user, params) {
  requireRole(user, 'admin')
  const targetId = params.id

  const target = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
    .bind(targetId).first()
  if (!target) return errorResponse('User not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { assignments } = body
  if (!Array.isArray(assignments)) return errorResponse('assignments must be an array', 400)

  // Delete existing assignments
  await env.DB.prepare('DELETE FROM user_workspaces WHERE user_id = ?').bind(targetId).run()

  // Insert new assignments
  for (const a of assignments) {
    if (!a.workspace_id) continue
    const uwId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).bind(uwId, targetId, a.workspace_id, a.permission || 'read').run()
  }

  await logAudit(env, user.userId, 'user.workspaces.update', {
    resourceType: 'user', resourceId: targetId,
    username: target.username, assignmentCount: assignments.length,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace assignments updated', count: assignments.length })
}
