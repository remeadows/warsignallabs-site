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

  // 'task' stays out of the request-validation allowlist until Phase 4 ships
  // tasks — the DB CHECK constraint permits it (schema pre-provisioned per
  // ADR-0004) but there's no tasks table to validate entity_id against yet.
  if (!['workspace', 'file'].includes(entityType)) {
    return errorResponse('entity_type must be one of: workspace, file', 400)
  }
  if (!entityId) return errorResponse('entity_id is required', 400)
  if (!body || !body.trim()) return errorResponse('body is required', 400)

  // Verify the target actually belongs to this workspace before attaching a
  // comment to it — otherwise a crafted entity_id can associate a comment
  // with another workspace's file, or a file that doesn't exist at all.
  if (entityType === 'workspace') {
    if (entityId !== workspace.id) {
      return errorResponse('entity_id must be this workspace\'s id for entity_type "workspace"', 400)
    }
  } else {
    const file = await env.DB.prepare('SELECT id FROM files WHERE id = ? AND workspace_id = ?')
      .bind(entityId, workspace.id).first()
    if (!file) return errorResponse('File not found in this workspace', 404)
  }

  if (parentId) {
    const parent = await env.DB.prepare(
      'SELECT id, entity_type, entity_id, parent_comment_id FROM comments WHERE id = ? AND workspace_id = ?',
    ).bind(parentId, workspace.id).first()
    if (!parent) return errorResponse('Parent comment not found', 404)
    // One level deep only (spec §2) — reject, never re-parent.
    if (parent.parent_comment_id) return errorResponse('Cannot reply to a reply', 400)
    // A reply must target the same entity as its parent — otherwise the
    // reply can end up filed under a different file/workspace thread than
    // the one it's actually replying to, and the client can never locate it
    // under its parent.
    if (parent.entity_type !== entityType || parent.entity_id !== entityId) {
      return errorResponse('Parent comment belongs to a different entity', 400)
    }
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
    `SELECT c.id, c.author_id, c.deleted_at, c.workspace_id, w.slug AS workspace_slug
     FROM comments c INNER JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.id = ?`,
  ).bind(params.id).first()
  // A deleted comment is 404, not 403 — it no longer exists as far as the API
  // is concerned (spec §2).
  if (!comment || comment.deleted_at) return errorResponse('Comment not found', 404)

  // Authorship alone isn't enough: a user removed from this workspace after
  // authoring a comment must not still be able to edit it. requireWorkspaceAccess
  // reflects CURRENT membership (workspaceSlugs is recomputed on every auth),
  // unlike isCommentEditableBy which only checks who wrote it.
  requireWorkspaceAccess(user, comment.workspace_slug)

  if (!isCommentEditableBy(user, comment)) {
    await logAudit(env, user.userId, 'comment.edit.denied', {
      resourceType: 'comment', resourceId: comment.id,
      workspaceId: comment.workspace_id,
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
    workspaceId: comment.workspace_id,
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

  // Same membership recheck as edit — a former member (author or not) must
  // not retain delete access via a stale authorship/permission check.
  requireWorkspaceAccess(user, comment.workspace_slug)

  const violation = commentDeleteViolation(user, comment, comment.workspace_slug)
  if (violation) {
    await logAudit(env, user.userId, 'comment.delete.denied', {
      resourceType: 'comment', resourceId: comment.id,
      workspaceId: comment.workspace_id,
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
