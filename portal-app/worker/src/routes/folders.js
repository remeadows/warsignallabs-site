// worker/src/routes/folders.js
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, escapeHtml } from '../notify.js'

/**
 * Validate folder name: no slashes, max 100 chars, non-empty.
 */
export function validateFolderName(name) {
  if (!name || typeof name !== 'string') return 'Folder name is required'
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'Folder name cannot be empty'
  if (trimmed.length > 100) return 'Folder name must be 100 characters or fewer'
  if (/[/\\]/.test(trimmed)) return 'Folder name cannot contain / or \\'
  return null
}

/**
 * GET /api/workspaces/:slug/folders — list root-level folders + files (folder_id IS NULL)
 * GET /api/workspaces/:slug/folders/:folderId — list contents of a specific folder
 */
export async function handleListFolderContents(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)

  const workspace = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  const folderId = params.folderId || null

  // If folderId is provided, verify it exists and belongs to this workspace
  if (folderId) {
    const folder = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND workspace_id = ?')
      .bind(folderId, workspace.id).first()
    if (!folder) return errorResponse('Folder not found', 404)
  }

  // Get subfolders
  const foldersQuery = folderId
    ? 'SELECT id, name, parent_folder_id, created_by, created_at, updated_at FROM folders WHERE workspace_id = ? AND parent_folder_id = ? ORDER BY name ASC'
    : 'SELECT id, name, parent_folder_id, created_by, created_at, updated_at FROM folders WHERE workspace_id = ? AND parent_folder_id IS NULL ORDER BY name ASC'
  const foldersResult = folderId
    ? await env.DB.prepare(foldersQuery).bind(workspace.id, folderId).all()
    : await env.DB.prepare(foldersQuery).bind(workspace.id).all()

  // Get files in this folder
  const filesQuery = folderId
    ? `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.version, f.folder_id, f.created_at,
              u.username AS uploaded_by_name
       FROM files f
       LEFT JOIN users u ON u.clerk_id = f.uploaded_by OR u.id = f.uploaded_by
       WHERE f.workspace_id = ? AND f.folder_id = ?
       ORDER BY f.created_at DESC`
    : `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.version, f.folder_id, f.created_at,
              u.username AS uploaded_by_name
       FROM files f
       LEFT JOIN users u ON u.clerk_id = f.uploaded_by OR u.id = f.uploaded_by
       WHERE f.workspace_id = ? AND f.folder_id IS NULL
       ORDER BY f.created_at DESC`
  const filesResult = folderId
    ? await env.DB.prepare(filesQuery).bind(workspace.id, folderId).all()
    : await env.DB.prepare(filesQuery).bind(workspace.id).all()

  // Build breadcrumb trail
  const breadcrumbs = []
  if (folderId) {
    let currentId = folderId
    while (currentId) {
      const crumb = await env.DB.prepare('SELECT id, name, parent_folder_id FROM folders WHERE id = ?')
        .bind(currentId).first()
      if (!crumb) break
      breadcrumbs.unshift({ id: crumb.id, name: crumb.name })
      currentId = crumb.parent_folder_id
    }
  }

  const files = filesResult.results.map((f) => ({ ...f, mime_type: f.content_type }))

  return jsonResponse({
    folders: foldersResult.results,
    files,
    breadcrumbs,
    currentFolderId: folderId,
  })
}

/**
 * POST /api/workspaces/:slug/folders — create a folder
 * Body: { name, parent_folder_id? }
 */
export async function handleCreateFolder(request, env, user, params, ctx) {
  if (!hasWorkspaceWriteAccess(user, params.slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }
  requireWorkspaceAccess(user, params.slug)

  const workspace = await env.DB.prepare('SELECT id, name FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON body', 400) }

  const nameError = validateFolderName(body.name)
  if (nameError) return errorResponse(nameError, 400)

  const folderName = body.name.trim()
  const parentFolderId = body.parent_folder_id || null

  // Validate parent folder exists and belongs to workspace
  if (parentFolderId) {
    const parent = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND workspace_id = ?')
      .bind(parentFolderId, workspace.id).first()
    if (!parent) return errorResponse('Parent folder not found in this workspace', 404)
  }

  // Check for duplicate name in same parent
  const dupQuery = parentFolderId
    ? 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id = ? AND LOWER(name) = LOWER(?)'
    : 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id IS NULL AND LOWER(name) = LOWER(?)'
  const dupBindings = parentFolderId
    ? [workspace.id, parentFolderId, folderName]
    : [workspace.id, folderName]
  const dup = await env.DB.prepare(dupQuery).bind(...dupBindings).first()
  if (dup) return errorResponse('A folder with that name already exists here', 409)

  const folderId = crypto.randomUUID()
  const createdBy = user.dbUserId || user.userId

  await env.DB.prepare(
    `INSERT INTO folders (id, workspace_id, parent_folder_id, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).bind(folderId, workspace.id, parentFolderId, folderName, createdBy).run()

  await logAudit(env, user.userId, 'folder.create', {
    resourceType: 'folder',
    resourceId: folderId,
    workspaceId: workspace.id,
    folderName,
    parentFolderId,
    workspaceSlug: params.slug,
    ipAddress: getClientIp(request),
  })

  // Notify
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'folder.create',
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: `Folder Created: ${escapeHtml(folderName)}`,
    bodyLines: [
      `<strong>Folder:</strong> ${escapeHtml(folderName)}`,
      `<strong>Workspace:</strong> ${escapeHtml(workspace.name)}`,
      `<strong>Created by:</strong> ${escapeHtml(user.email || user.userId)}`,
    ],
    actorEmail: user.email,
    metadata: { folderId, folderName, workspaceSlug: params.slug },
  })

  return jsonResponse({ folder: { id: folderId, workspace_id: workspace.id, name: folderName, parent_folder_id: parentFolderId }, message: 'Folder created' }, 201)
}

/**
 * PATCH /api/folders/:id — rename a folder
 * Body: { name }
 */
export async function handleRenameFolder(request, env, user, params) {
  const folder = await env.DB.prepare(
    `SELECT f.id, f.name, f.workspace_id, f.parent_folder_id, w.slug AS workspace_slug
     FROM folders f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(params.id).first()
  if (!folder) return errorResponse('Folder not found', 404)

  if (!hasWorkspaceWriteAccess(user, folder.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }
  requireWorkspaceAccess(user, folder.workspace_slug)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON body', 400) }

  const nameError = validateFolderName(body.name)
  if (nameError) return errorResponse(nameError, 400)

  const newName = body.name.trim()

  // Check for duplicate name in same parent
  const dupQuery = folder.parent_folder_id
    ? 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id = ? AND LOWER(name) = LOWER(?) AND id != ?'
    : 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id IS NULL AND LOWER(name) = LOWER(?) AND id != ?'
  const dupBindings = folder.parent_folder_id
    ? [folder.workspace_id, folder.parent_folder_id, newName, folder.id]
    : [folder.workspace_id, newName, folder.id]
  const dup = await env.DB.prepare(dupQuery).bind(...dupBindings).first()
  if (dup) return errorResponse('A folder with that name already exists here', 409)

  await env.DB.prepare("UPDATE folders SET name = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newName, folder.id).run()

  await logAudit(env, user.userId, 'folder.rename', {
    resourceType: 'folder',
    resourceId: folder.id,
    workspaceId: folder.workspace_id,
    oldName: folder.name,
    newName,
    workspaceSlug: folder.workspace_slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ folder: { id: folder.id, name: newName }, message: 'Folder renamed' })
}

/**
 * DELETE /api/folders/:id — delete folder (must be empty)
 */
export async function handleDeleteFolder(request, env, user, params, ctx) {
  const folder = await env.DB.prepare(
    `SELECT f.id, f.name, f.workspace_id, w.slug AS workspace_slug, w.name AS workspace_name
     FROM folders f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(params.id).first()
  if (!folder) return errorResponse('Folder not found', 404)

  if (!hasWorkspaceWriteAccess(user, folder.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }
  requireWorkspaceAccess(user, folder.workspace_slug)

  // Check for children
  const childFolders = await env.DB.prepare('SELECT COUNT(*) as cnt FROM folders WHERE parent_folder_id = ?')
    .bind(folder.id).first()
  const childFiles = await env.DB.prepare('SELECT COUNT(*) as cnt FROM files WHERE folder_id = ?')
    .bind(folder.id).first()

  const totalChildren = (childFolders?.cnt || 0) + (childFiles?.cnt || 0)
  if (totalChildren > 0) {
    return errorResponse(`Cannot delete folder: contains ${childFolders?.cnt || 0} subfolder(s) and ${childFiles?.cnt || 0} file(s). Move or delete contents first.`, 409)
  }

  await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(folder.id).run()

  await logAudit(env, user.userId, 'folder.delete', {
    resourceType: 'folder',
    resourceId: folder.id,
    workspaceId: folder.workspace_id,
    folderName: folder.name,
    workspaceSlug: folder.workspace_slug,
    ipAddress: getClientIp(request),
  })

  // Notify
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'folder.delete',
    workspaceId: folder.workspace_id,
    workspaceName: folder.workspace_name,
    title: `Folder Deleted: ${escapeHtml(folder.name)}`,
    bodyLines: [
      `<strong>Folder:</strong> ${escapeHtml(folder.name)}`,
      `<strong>Workspace:</strong> ${escapeHtml(folder.workspace_name)}`,
      `<strong>Deleted by:</strong> ${escapeHtml(user.email || user.userId)}`,
    ],
    actorEmail: user.email,
    metadata: { folderId: folder.id, folderName: folder.name, workspaceSlug: folder.workspace_slug },
  })

  return jsonResponse({ message: 'Folder deleted' })
}

/**
 * PATCH /api/folders/:id/move — move a folder to a new parent
 * Body: { parent_folder_id } (null = move to root)
 */
export async function handleMoveFolder(request, env, user, params, ctx) {
  const folder = await env.DB.prepare(
    `SELECT f.id, f.name, f.workspace_id, f.parent_folder_id, w.slug AS workspace_slug, w.name AS workspace_name
     FROM folders f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(params.id).first()
  if (!folder) return errorResponse('Folder not found', 404)

  if (!hasWorkspaceWriteAccess(user, folder.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }
  requireWorkspaceAccess(user, folder.workspace_slug)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON body', 400) }

  const newParentId = body.parent_folder_id === undefined ? folder.parent_folder_id : body.parent_folder_id

  // Cannot move to self
  if (newParentId === folder.id) {
    return errorResponse('Cannot move a folder into itself', 400)
  }

  // Validate target parent folder
  if (newParentId) {
    const target = await env.DB.prepare('SELECT id, workspace_id FROM folders WHERE id = ?')
      .bind(newParentId).first()
    if (!target) return errorResponse('Target parent folder not found', 404)
    if (target.workspace_id !== folder.workspace_id) {
      return errorResponse('Cannot move folders across workspaces', 403)
    }

    // Circular reference check: walk up from target to root, ensure we never hit folder.id
    let checkId = newParentId
    while (checkId) {
      if (checkId === folder.id) {
        return errorResponse('Cannot move a folder into one of its own descendants', 400)
      }
      const ancestor = await env.DB.prepare('SELECT parent_folder_id FROM folders WHERE id = ?')
        .bind(checkId).first()
      checkId = ancestor?.parent_folder_id || null
    }
  }

  // Check duplicate name in new parent
  const dupQuery = newParentId
    ? 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id = ? AND LOWER(name) = LOWER(?) AND id != ?'
    : 'SELECT id FROM folders WHERE workspace_id = ? AND parent_folder_id IS NULL AND LOWER(name) = LOWER(?) AND id != ?'
  const dupBindings = newParentId
    ? [folder.workspace_id, newParentId, folder.name, folder.id]
    : [folder.workspace_id, folder.name, folder.id]
  const dup = await env.DB.prepare(dupQuery).bind(...dupBindings).first()
  if (dup) return errorResponse('A folder with that name already exists in the target location', 409)

  await env.DB.prepare("UPDATE folders SET parent_folder_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newParentId, folder.id).run()

  await logAudit(env, user.userId, 'folder.move', {
    resourceType: 'folder',
    resourceId: folder.id,
    workspaceId: folder.workspace_id,
    folderName: folder.name,
    fromParentId: folder.parent_folder_id,
    toParentId: newParentId,
    workspaceSlug: folder.workspace_slug,
    ipAddress: getClientIp(request),
  })

  notifyWorkspaceEvent(env, ctx, {
    eventType: 'folder.move',
    workspaceId: folder.workspace_id,
    workspaceName: folder.workspace_name,
    title: `Folder Moved: ${escapeHtml(folder.name)}`,
    bodyLines: [
      `<strong>Folder:</strong> ${escapeHtml(folder.name)}`,
      `<strong>Workspace:</strong> ${escapeHtml(folder.workspace_name)}`,
      `<strong>Moved by:</strong> ${escapeHtml(user.email || user.userId)}`,
    ],
    actorEmail: user.email,
    metadata: { folderId: folder.id, folderName: folder.name, fromParentId: folder.parent_folder_id, toParentId: newParentId },
  })

  return jsonResponse({ message: 'Folder moved', folder: { id: folder.id, parent_folder_id: newParentId } })
}
