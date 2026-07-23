// worker/src/routes/tasks.js
// Tasks within a workspace project (Phase 4). Notifications are directed
// (recipientOverride to the assignee only) with actor exclusion HERE at the
// call sites — recipientOverride deliberately has none (spec §4).
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, taskDeleteViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, resolveMentionRecipients, escapeHtml } from '../notify.js'

const TASK_STATUSES = ['todo', 'in_progress', 'done']
const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Fetch a non-deleted project + workspace context for the :id-addressed task routes. */
async function getProjectContext(env, projectId) {
  return env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.deleted_at, w.slug AS workspace_slug, w.name AS workspace_name
     FROM projects p INNER JOIN workspaces w ON w.id = p.workspace_id
     WHERE p.id = ?`,
  ).bind(projectId).first()
}

async function getTaskWithContext(env, taskId) {
  return env.DB.prepare(
    `SELECT t.id, t.project_id, t.workspace_id, t.title, t.status, t.assignee_id,
            t.due_date, t.created_by, t.deleted_at,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM tasks t INNER JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.id = ?`,
  ).bind(taskId).first()
}

/** Assignee must be an active workspace member or an active global admin. */
async function isValidAssignee(env, workspaceId, assigneeId) {
  const row = await env.DB.prepare(
    `SELECT u.id FROM users u
     LEFT JOIN user_workspaces uw ON uw.user_id = u.id AND uw.workspace_id = ?
     WHERE u.id = ? AND u.status = 'active' AND (uw.id IS NOT NULL OR u.role = 'admin')`,
  ).bind(workspaceId, assigneeId).first()
  return !!row
}

function taskLink(slug, projectId, taskId) {
  // Pinned deep-link shape (spec §3) — this string is stored in
  // notification_inbox.link rows, so keep it in exactly this form.
  return `/workspace/${slug}?tab=projects&projectId=${projectId}&taskId=${taskId}`
}

/**
 * Directed notification to the task's assignee. Silently does nothing when
 * there is no assignee or the assignee IS the actor (spec §4 actor exclusion —
 * the assignee moving their own task must not ping their own bell).
 */
async function notifyAssignee(env, ctx, { eventType, assigneeId, actor, workspace, slug, projectId, taskId, title, bodyLines }) {
  if (!assigneeId || assigneeId === actor.dbUserId) return
  const recipients = await resolveMentionRecipients(env, [assigneeId])
  if (recipients.length === 0) return
  notifyWorkspaceEvent(env, ctx, {
    eventType,
    workspaceId: workspace.workspace_id || workspace.id,
    workspaceName: workspace.workspace_name || workspace.name,
    title,
    bodyLines,
    actorEmail: actor.email,
    link: taskLink(slug, projectId, taskId),
    recipientOverride: recipients.map((r) => ({ email: r.email, userId: r.userId, emailPref: r.emailPref })),
    metadata: { taskId, projectId },
  })
}

/** GET /api/projects/:id/tasks — any member. ?include_deleted=1 is GLOBAL-admin-only. */
export async function handleListTasks(request, env, user, params) {
  const project = await getProjectContext(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  requireWorkspaceAccess(user, project.workspace_slug)

  const url = new URL(request.url)
  const includeDeleted = url.searchParams.get('include_deleted') === '1' && user.role === 'admin'

  const result = await env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.assignee_id, t.due_date,
            t.sort_order, t.created_by, t.created_at, t.updated_at, t.deleted_at,
            u.username AS assignee_username,
            (SELECT COUNT(*) FROM comments c
             WHERE c.entity_type = 'task' AND c.entity_id = t.id AND c.deleted_at IS NULL) AS comment_count
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.project_id = ?${includeDeleted ? '' : ' AND t.deleted_at IS NULL'}
     ORDER BY t.status, t.sort_order`,
  ).bind(project.id).all()

  return jsonResponse({ tasks: result.results })
}

/** POST /api/projects/:id/tasks — wsWrite. Body: {title, description?, assignee_id?, due_date?} */
export async function handleCreateTask(request, env, user, params, ctx) {
  const project = await getProjectContext(env, params.id)
  if (!project || project.deleted_at) return errorResponse('Project not found', 404)
  if (!hasWorkspaceWriteAccess(user, project.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required to create a task', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  if (!body?.title || !body.title.trim()) return errorResponse('title is required', 400)
  if (body.due_date && !DATE_RE.test(body.due_date)) {
    return errorResponse('due_date must be YYYY-MM-DD', 400)
  }
  if (body.assignee_id && !(await isValidAssignee(env, project.workspace_id, body.assignee_id))) {
    return errorResponse('assignee_id is not an active member of this workspace', 400)
  }

  // sort_order is write-once (ADR-0005): append to the end of the 'todo'
  // column (all new tasks start as 'todo'); never updated after this.
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tasks
     WHERE project_id = ? AND status = 'todo' AND deleted_at IS NULL`,
  ).bind(project.id).first()

  const taskId = `tsk-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO tasks (id, project_id, workspace_id, title, description, assignee_id, due_date, sort_order, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(
    taskId, project.id, project.workspace_id, body.title.trim(),
    body.description?.trim() || null, body.assignee_id || null,
    body.due_date || null, (maxRow?.max_order || 0) + 1, user.dbUserId,
  ).run()

  await logAudit(env, user.userId, 'task.create', {
    resourceType: 'task', resourceId: taskId,
    workspaceId: project.workspace_id, workspaceSlug: project.workspace_slug,
    projectId: project.id, title: body.title.trim(),
    ipAddress: getClientIp(request),
  })

  // task.assign fires on creation-with-assignee too (spec §4).
  await notifyAssignee(env, ctx, {
    eventType: 'task.assign',
    assigneeId: body.assignee_id || null,
    actor: user,
    workspace: project,
    slug: project.workspace_slug,
    projectId: project.id,
    taskId,
    title: `You were assigned "${escapeHtml(body.title.trim())}" in ${escapeHtml(project.workspace_name)}`,
    bodyLines: [
      `<strong>${escapeHtml(user.email || 'Someone')}</strong> assigned you a task:`,
      escapeHtml(body.title.trim()),
    ],
  })

  return jsonResponse({ task: { id: taskId, title: body.title.trim(), status: 'todo' } }, 201)
}

/** PATCH /api/tasks/:id — wsWrite. Body: {title?, description?, status?, assignee_id?, due_date?} */
export async function handleUpdateTask(request, env, user, params, ctx) {
  const task = await getTaskWithContext(env, params.id)
  if (!task || task.deleted_at) return errorResponse('Task not found', 404)
  if (!hasWorkspaceWriteAccess(user, task.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const updates = []
  const bindings = []
  if (body.title !== undefined) {
    if (!body.title || !body.title.trim()) return errorResponse('title cannot be empty', 400)
    updates.push('title = ?'); bindings.push(body.title.trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?'); bindings.push(body.description?.trim() || null)
  }
  if (body.due_date !== undefined) {
    if (body.due_date && !DATE_RE.test(body.due_date)) {
      return errorResponse('due_date must be YYYY-MM-DD', 400)
    }
    updates.push('due_date = ?'); bindings.push(body.due_date || null)
  }
  const statusChanged = body.status !== undefined && body.status !== task.status
  if (body.status !== undefined) {
    if (!TASK_STATUSES.includes(body.status)) {
      return errorResponse(`status must be one of: ${TASK_STATUSES.join(', ')}`, 400)
    }
    if (statusChanged) { updates.push('status = ?'); bindings.push(body.status) }
  }
  const assigneeChanged = body.assignee_id !== undefined && body.assignee_id !== task.assignee_id
  if (assigneeChanged) {
    if (body.assignee_id && !(await isValidAssignee(env, task.workspace_id, body.assignee_id))) {
      return errorResponse('assignee_id is not an active member of this workspace', 400)
    }
    updates.push('assignee_id = ?'); bindings.push(body.assignee_id || null)
  }
  if (updates.length === 0) return errorResponse('No fields to update', 400)

  updates.push("updated_at = datetime('now')")
  bindings.push(task.id)
  await env.DB.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).bind(...bindings).run()

  // Audit: status transitions get their own action so the Activity feed can
  // label them distinctly ("moved X to done" vs "edited a task").
  await logAudit(env, user.userId, statusChanged ? 'task.status' : 'task.update', {
    resourceType: 'task', resourceId: task.id,
    workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
    projectId: task.project_id, title: task.title,
    ...(statusChanged ? { from: task.status, to: body.status } : { changes: Object.keys(body) }),
    ipAddress: getClientIp(request),
  })

  // task.assign — only on a change to a NEW non-null assignee (spec §4).
  if (assigneeChanged && body.assignee_id) {
    await notifyAssignee(env, ctx, {
      eventType: 'task.assign',
      assigneeId: body.assignee_id,
      actor: user,
      workspace: task,
      slug: task.workspace_slug,
      projectId: task.project_id,
      taskId: task.id,
      title: `You were assigned "${escapeHtml(task.title)}" in ${escapeHtml(task.workspace_name)}`,
      bodyLines: [
        `<strong>${escapeHtml(user.email || 'Someone')}</strong> assigned you a task:`,
        escapeHtml(task.title),
      ],
    })
  }

  // task.status — to the CURRENT assignee (post-update if it changed in the
  // same PATCH), actor-excluded inside notifyAssignee.
  if (statusChanged) {
    const currentAssignee = assigneeChanged ? (body.assignee_id || null) : task.assignee_id
    await notifyAssignee(env, ctx, {
      eventType: 'task.status',
      assigneeId: currentAssignee,
      actor: user,
      workspace: task,
      slug: task.workspace_slug,
      projectId: task.project_id,
      taskId: task.id,
      title: `"${escapeHtml(task.title)}" moved to ${STATUS_LABELS[body.status]} in ${escapeHtml(task.workspace_name)}`,
      bodyLines: [
        `<strong>${escapeHtml(user.email || 'Someone')}</strong> moved a task to <strong>${STATUS_LABELS[body.status]}</strong>:`,
        escapeHtml(task.title),
      ],
    })
  }

  return jsonResponse({ message: 'Task updated' })
}

/** DELETE /api/tasks/:id — creator or wsAdmin. Soft delete only. */
export async function handleDeleteTask(request, env, user, params) {
  const task = await getTaskWithContext(env, params.id)
  if (!task || task.deleted_at) return errorResponse('Task not found', 404)
  requireWorkspaceAccess(user, task.workspace_slug)

  const violation = taskDeleteViolation(user, task, task.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'task.delete.denied', {
      resourceType: 'task', resourceId: task.id,
      workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
      reason: violation, ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(task.id).run()

  await logAudit(env, user.userId, 'task.delete', {
    resourceType: 'task', resourceId: task.id,
    workspaceId: task.workspace_id, workspaceSlug: task.workspace_slug,
    projectId: task.project_id, title: task.title,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Task deleted' })
}
