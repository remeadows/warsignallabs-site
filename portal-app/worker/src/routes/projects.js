// worker/src/routes/projects.js
// Workspace projects (Phase 4). NOT the GW-OS ops dashboard's "projects"
// (routes/admin.js handleDashboardProjects) — unrelated domain.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, projectDeleteViolation, projectDeleteBlocked } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { getWorkspaceBySlug } from './members.js'

const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived']

/** Fetch a project + its workspace slug, or null. Used by PATCH/DELETE (id-addressed). */
async function getProjectWithWorkspace(env, projectId) {
  return env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.name, p.status, p.created_by, p.deleted_at,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM projects p INNER JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = ?`,
  ).bind(projectId).first()
}

/** GET /api/workspaces/:slug/projects — any member. ?include_deleted=1 is GLOBAL-admin-only. */
export async function handleListProjects(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const url = new URL(request.url)
  const includeDeleted = url.searchParams.get('include_deleted') === '1' && user.role === 'admin'

  const result = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.status, p.created_by, p.created_at, p.updated_at, p.deleted_at,
            u.username AS created_by_username,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.deleted_at IS NULL) AS open_task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done' AND t.deleted_at IS NULL) AS done_task_count
     FROM projects p LEFT JOIN users u ON u.id = p.created_by
     WHERE p.workspace_id = ?${includeDeleted ? '' : ' AND p.deleted_at IS NULL'}
     ORDER BY p.created_at DESC`,
  ).bind(workspace.id).all()

  return jsonResponse({ projects: result.results })
}

/** POST /api/workspaces/:slug/projects — wsWrite. Body: {name, description?} */
export async function handleCreateProject(request, env, user, params) {
  if (!hasWorkspaceWriteAccess(user, params.slug)) {
    throw errorResponse('Forbidden: write permission required to create a project', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!body?.name || !body.name.trim()) return errorResponse('name is required', 400)

  const projectId = `prj-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO projects (id, workspace_id, name, description, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(projectId, workspace.id, body.name.trim(), body.description?.trim() || null, user.dbUserId).run()

  await logAudit(env, user.userId, 'project.create', {
    resourceType: 'project', resourceId: projectId,
    workspaceId: workspace.id, workspaceSlug: params.slug,
    name: body.name.trim(), ipAddress: getClientIp(request),
  })

  return jsonResponse({ project: { id: projectId, name: body.name.trim(), status: 'active' } }, 201)
}

/** PATCH /api/projects/:id — wsWrite. Body: {name?, description?, status?} */
export async function handleUpdateProject(request, env, user, params) {
  const project = await getProjectWithWorkspace(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  if (!hasWorkspaceWriteAccess(user, project.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const updates = []
  const bindings = []
  if (body.name !== undefined) {
    if (!body.name || !body.name.trim()) return errorResponse('name cannot be empty', 400)
    updates.push('name = ?'); bindings.push(body.name.trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?'); bindings.push(body.description?.trim() || null)
  }
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status)) {
      return errorResponse(`status must be one of: ${PROJECT_STATUSES.join(', ')}`, 400)
    }
    updates.push('status = ?'); bindings.push(body.status)
  }
  if (updates.length === 0) return errorResponse('No fields to update', 400)

  updates.push("updated_at = datetime('now')")
  bindings.push(project.id)
  await env.DB.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings).run()

  await logAudit(env, user.userId, 'project.update', {
    resourceType: 'project', resourceId: project.id,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    changes: Object.keys(body), ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Project updated' })
}

/** DELETE /api/projects/:id — creator or wsAdmin. Soft delete; 409 on open tasks unless ?force=1. */
export async function handleDeleteProject(request, env, user, params) {
  const project = await getProjectWithWorkspace(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  requireWorkspaceAccess(user, project.workspace_slug)

  const violation = projectDeleteViolation(user, project, project.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'project.delete.denied', {
      resourceType: 'project', resourceId: project.id,
      workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
      reason: violation, ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  const url = new URL(request.url)
  const force = url.searchParams.get('force') === '1'
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM tasks
     WHERE project_id = ? AND status IN ('todo','in_progress') AND deleted_at IS NULL`,
  ).bind(project.id).first()

  const blocked = projectDeleteBlocked(open?.count || 0, force)
  if (blocked) return errorResponse(blocked, 409)

  // With force: soft-delete the open tasks too. Batched so the pair applies
  // atomically (D1 batch = implicit transaction) — a failure can't leave the
  // project deleted with its open tasks still live, or vice versa. Done
  // tasks stay untouched.
  const statements = []
  if (force && open?.count > 0) {
    statements.push(env.DB.prepare(
      `UPDATE tasks SET deleted_at = datetime('now')
       WHERE project_id = ? AND status IN ('todo','in_progress') AND deleted_at IS NULL`,
    ).bind(project.id))
  }
  statements.push(env.DB.prepare(`UPDATE projects SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(project.id))
  await env.DB.batch(statements)

  await logAudit(env, user.userId, 'project.delete', {
    resourceType: 'project', resourceId: project.id,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    name: project.name, forcedOpenTasks: force ? (open?.count || 0) : 0,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Project deleted' })
}
