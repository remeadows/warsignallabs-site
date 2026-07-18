// worker/src/routes/files.js
import { jsonResponse, errorResponse, CORS_HEADERS, SECURITY_HEADERS } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { notifyWorkspaceEvent, checkStorageThreshold } from '../notify.js'

/**
 * Allowed MIME types for upload.
 */
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
  'image/png',
  'image/jpeg',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
])

export const VALID_CATEGORIES = new Set(['invoices', 'documents', 'deliverables', 'reports'])

export const MAX_FILE_SIZE = 50 * 1024 * 1024

/**
 * GET /api/workspaces/:slug/files — returns files for a workspace
 * D1 schema: files(id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
 */
export async function handleListFiles(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)

  const workspace = await env.DB.prepare(
    'SELECT id FROM workspaces WHERE slug = ?',
  )
    .bind(params.slug)
    .first()

  if (!workspace) {
    return errorResponse('Workspace not found', 404)
  }

  const url = new URL(request.url)
  const category = url.searchParams.get('category')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  let query
  let bindings

  if (category) {
    query = `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.version, f.created_at,
                    u.username AS uploaded_by_name
             FROM files f
             LEFT JOIN users u ON u.clerk_id = f.uploaded_by OR u.id = f.uploaded_by
             WHERE f.workspace_id = ? AND f.category = ?
             ORDER BY f.created_at DESC
             LIMIT ? OFFSET ?`
    bindings = [workspace.id, category, limit, offset]
  } else {
    query = `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.version, f.created_at,
                    u.username AS uploaded_by_name
             FROM files f
             LEFT JOIN users u ON u.clerk_id = f.uploaded_by OR u.id = f.uploaded_by
             WHERE f.workspace_id = ?
             ORDER BY f.created_at DESC
             LIMIT ? OFFSET ?`
    bindings = [workspace.id, limit, offset]
  }

  const result = await env.DB.prepare(query).bind(...bindings).all()

  const countQuery = category
    ? 'SELECT COUNT(*) as total FROM files WHERE workspace_id = ? AND category = ?'
    : 'SELECT COUNT(*) as total FROM files WHERE workspace_id = ?'
  const countBindings = category ? [workspace.id, category] : [workspace.id]
  const countResult = await env.DB.prepare(countQuery).bind(...countBindings).first()

  // Map content_type to mime_type for frontend compatibility
  const files = result.results.map((f) => ({
    ...f,
    mime_type: f.content_type,
  }))

  return jsonResponse({
    files,
    pagination: {
      total: countResult?.total || 0,
      limit,
      offset,
    },
  })
}

/**
 * POST /api/workspaces/:slug/files — upload a file via multipart/form-data.
 * D1 schema: files(id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
 */
export async function handleUploadFile(request, env, user, params, ctx) {
  // Allow admin/owner roles OR clients with workspace-level write permission
  if (!hasWorkspaceWriteAccess(user, params.slug)) {
    throw errorResponse(
      'Forbidden: you need write permission on this workspace to upload files',
      403,
    )
  }
  requireWorkspaceAccess(user, params.slug)

  const workspace = await env.DB.prepare(
    'SELECT id FROM workspaces WHERE slug = ?',
  )
    .bind(params.slug)
    .first()

  if (!workspace) {
    return errorResponse('Workspace not found', 404)
  }

  let formData
  try {
    formData = await request.formData()
  } catch {
    return errorResponse('Invalid multipart form data', 400)
  }

  const file = formData.get('file')
  const category = formData.get('category') || 'documents'
  const folderId = formData.get('folder_id') || null

  if (!file || !(file instanceof File)) {
    return errorResponse('Missing required field: file', 400)
  }

  if (!VALID_CATEGORIES.has(category)) {
    return errorResponse(`Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(', ')}`, 400)
  }

  if (file.size > MAX_FILE_SIZE) {
    return errorResponse(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB`, 400)
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return errorResponse(`File type not allowed: ${file.type}`, 400)
  }

  // Validate folder_id if provided
  if (folderId) {
    const targetFolder = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND workspace_id = ?')
      .bind(folderId, workspace.id).first()
    if (!targetFolder) return errorResponse('Target folder not found in this workspace', 404)
  }

  const rawName = file.name || 'unnamed'
  const sanitized = rawName.replace(/[/\\]/g, '_').slice(0, 200)

  const fileId = crypto.randomUUID()
  const r2Key = `${workspace.id}/${category}/${fileId}_${sanitized}`

  // Upload to R2
  await env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: params.slug,
      originalFilename: sanitized,
    },
  })

  // Use dbUserId for the foreign key, fall back to clerk ID
  const uploadedBy = user.dbUserId || user.userId

  // Record in D1
  await env.DB.prepare(
    `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, folder_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(fileId, workspace.id, category, sanitized, r2Key, file.size, file.type, uploadedBy, folderId)
    .run()

  await logAudit(env, user.userId, 'file.upload', {
    resourceType: 'file',
    resourceId: fileId,
    filename: sanitized,
    workspaceSlug: params.slug,
    sizeBytes: file.size,
    category,
    ipAddress: getClientIp(request),
  })

  // Notify workspace members + admins
  const wsInfo = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(workspace.id).first()
  const sizeMb = (file.size / (1024 * 1024)).toFixed(2)
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'file.upload',
    workspaceId: workspace.id,
    workspaceName: wsInfo?.name || params.slug,
    title: `File Uploaded: ${sanitized}`,
    bodyLines: [
      `<strong>File:</strong> ${sanitized}`,
      `<strong>Workspace:</strong> ${wsInfo?.name || params.slug}`,
      `<strong>Category:</strong> ${category}`,
      `<strong>Size:</strong> ${sizeMb} MB`,
      `<strong>Uploaded by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { fileId, filename: sanitized, workspaceSlug: params.slug, category, sizeBytes: file.size },
  })

  // Check 75% storage threshold
  checkStorageThreshold(env, ctx, {
    workspaceId: workspace.id,
    workspaceName: wsInfo?.name || params.slug,
    workspaceSlug: params.slug,
    actorEmail: user.email,
  })

  return jsonResponse(
    {
      file: {
        id: fileId,
        workspace_id: workspace.id,
        filename: sanitized,
        r2_key: r2Key,
        size_bytes: file.size,
        mime_type: file.type,
        category,
        folder_id: folderId,
      },
      message: 'File uploaded successfully',
    },
    201,
  )
}

/**
 * PUT /api/files/:id — replace a file with a new version.
 * Archives the current version to file_versions, uploads the new file to R2,
 * and updates the files record with the new R2 key, size, and version number.
 * Requires write permission on the workspace.
 */
export async function handleReplaceFile(request, env, user, params, ctx) {
  const fileId = params.id

  // Fetch existing file + workspace info
  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category,
            f.workspace_id, f.version, f.uploaded_by, w.slug AS workspace_slug, w.name AS workspace_name
     FROM files f
     INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(fileId).first()

  if (!file) return errorResponse('File not found', 404)

  // Check workspace write permission
  if (!hasWorkspaceWriteAccess(user, file.workspace_slug)) {
    throw errorResponse('Forbidden: you need write permission on this workspace to replace files', 403)
  }

  let formData
  try { formData = await request.formData() } catch { return errorResponse('Invalid multipart form data', 400) }

  const newFile = formData.get('file')
  if (!newFile || !(newFile instanceof File)) {
    return errorResponse('Missing required field: file', 400)
  }

  if (newFile.size > MAX_FILE_SIZE) {
    return errorResponse(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB`, 400)
  }

  if (!ALLOWED_MIME_TYPES.has(newFile.type)) {
    return errorResponse(`File type not allowed: ${newFile.type}`, 400)
  }

  const newVersion = (file.version || 1) + 1

  // 1. Archive current version to file_versions
  const versionId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO file_versions (id, file_id, version_number, r2_key, size_bytes, content_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).bind(
    versionId, fileId, file.version || 1, file.r2_key,
    file.size_bytes, file.content_type, file.uploaded_by,
  ).run()

  // 2. Upload new file to R2 with new key
  const sanitized = (newFile.name || file.filename).replace(/[/\\]/g, '_').slice(0, 200)
  const newR2Key = `${file.workspace_id}/${file.category}/${fileId}_v${newVersion}_${sanitized}`

  await env.FILES.put(newR2Key, newFile.stream(), {
    httpMetadata: { contentType: newFile.type },
    customMetadata: {
      uploadedBy: user.userId,
      workspaceSlug: file.workspace_slug,
      originalFilename: sanitized,
      version: String(newVersion),
    },
  })

  // 3. Update files record — new r2_key, size, content_type, version, filename
  const uploadedBy = user.dbUserId || user.userId
  await env.DB.prepare(
    `UPDATE files SET r2_key = ?, size_bytes = ?, content_type = ?, filename = ?,
            version = ?, uploaded_by = ?, created_at = datetime('now')
     WHERE id = ?`,
  ).bind(newR2Key, newFile.size, newFile.type, sanitized, newVersion, uploadedBy, fileId).run()

  // 4. Optionally delete old R2 object (keep for now — archived versions remain accessible)
  // Old R2 key preserved in file_versions for rollback capability

  await logAudit(env, user.userId, 'file.replace', {
    resourceType: 'file', resourceId: fileId,
    filename: sanitized, previousVersion: file.version || 1, newVersion,
    workspaceSlug: file.workspace_slug, sizeBytes: newFile.size,
    ipAddress: getClientIp(request),
  })

  // Notify
  const sizeMb = (newFile.size / (1024 * 1024)).toFixed(2)
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'file.replace',
    workspaceId: file.workspace_id,
    workspaceName: file.workspace_name || file.workspace_slug,
    title: `File Updated: ${sanitized} (v${newVersion})`,
    bodyLines: [
      `<strong>File:</strong> ${sanitized}`,
      `<strong>Workspace:</strong> ${file.workspace_name || file.workspace_slug}`,
      `<strong>Version:</strong> v${file.version || 1} → v${newVersion}`,
      `<strong>Size:</strong> ${sizeMb} MB`,
      `<strong>Updated by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { fileId, filename: sanitized, version: newVersion, workspaceSlug: file.workspace_slug },
  })

  // Check threshold after replacement
  checkStorageThreshold(env, ctx, {
    workspaceId: file.workspace_id,
    workspaceName: file.workspace_name || file.workspace_slug,
    workspaceSlug: file.workspace_slug,
    actorEmail: user.email,
  })

  return jsonResponse({
    file: {
      id: fileId,
      filename: sanitized,
      r2_key: newR2Key,
      size_bytes: newFile.size,
      mime_type: newFile.type,
      version: newVersion,
      category: file.category,
    },
    previousVersion: file.version || 1,
    message: `File updated to version ${newVersion}`,
  })
}

/**
 * GET /api/files/:id/versions — returns version history for a file
 */
export async function handleGetFileVersions(request, env, user, params) {
  const fileId = params.id

  // Get the file and check workspace access
  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.version, f.created_at,
            w.slug AS workspace_slug, w.name AS workspace_name
     FROM files f
     INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(fileId).first()

  if (!file) return errorResponse('File not found', 404)
  requireWorkspaceAccess(user, file.workspace_slug)

  // Get archived versions
  const versions = await env.DB.prepare(
    `SELECT fv.id, fv.version_number, fv.size_bytes, fv.content_type, fv.created_at,
            u.username AS uploaded_by_name
     FROM file_versions fv
     LEFT JOIN users u ON u.clerk_id = fv.uploaded_by OR u.id = fv.uploaded_by
     WHERE fv.file_id = ?
     ORDER BY fv.version_number DESC`,
  ).bind(fileId).all()

  return jsonResponse({
    fileId,
    filename: file.filename,
    currentVersion: file.version || 1,
    versions: [
      // Current version first
      {
        version_number: file.version || 1,
        size_bytes: file.size_bytes,
        content_type: file.content_type,
        created_at: file.created_at,
        current: true,
      },
      // Archived versions
      ...versions.results.map((v) => ({
        id: v.id,
        version_number: v.version_number,
        size_bytes: v.size_bytes,
        content_type: v.content_type,
        created_at: v.created_at,
        uploaded_by_name: v.uploaded_by_name,
        current: false,
      })),
    ],
  })
}

export async function handleDeleteFile(request, env, user, params, ctx) {
  const fileId = params.id

  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.workspace_id, w.slug AS workspace_slug
     FROM files f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  )
    .bind(fileId)
    .first()

  if (!file) {
    return errorResponse('File not found', 404)
  }

  // Ceiling (§3.1): global admin anywhere; otherwise admin permission on THIS
  // workspace. write/read members — including owners — cannot delete files.
  if (!hasWorkspaceAdminPermission(user, file.workspace_slug)) {
    await logAudit(env, user.userId, 'file.delete.denied', {
      resourceType: 'file', resourceId: fileId,
      workspaceSlug: file.workspace_slug, ipAddress: getClientIp(request),
    })
    throw errorResponse('Forbidden: workspace admin permission required to delete files', 403)
  }

  if (env.FILES && file.r2_key) {
    try {
      await env.FILES.delete(file.r2_key)
    } catch (err) {
      console.error('R2 delete failed:', err.message)
    }
  }

  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fileId).run()

  await logAudit(env, user.userId, 'file.delete', {
    resourceType: 'file',
    resourceId: fileId,
    filename: file.filename,
    r2Key: file.r2_key,
    ipAddress: getClientIp(request),
  })

  // Notify on deletion
  const wsInfo = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(file.workspace_id).first()
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'file.delete',
    workspaceId: file.workspace_id,
    workspaceName: wsInfo?.name || file.workspace_id,
    title: `File Deleted: ${file.filename}`,
    bodyLines: [
      `<strong>File:</strong> ${file.filename}`,
      `<strong>Workspace:</strong> ${wsInfo?.name || file.workspace_id}`,
      `<strong>Deleted by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { fileId, filename: file.filename, workspaceId: file.workspace_id },
  })

  return jsonResponse({ message: 'File deleted', fileId })
}

/**
 * GET /api/files/:id/download — stream from R2
 * D1 schema: content_type (not mime_type)
 */
export async function handleDownloadFile(request, env, user, params, ctx) {
  const fileId = params.id

  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.r2_key, f.content_type, f.size_bytes, w.slug AS workspace_slug
     FROM files f
     INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  )
    .bind(fileId)
    .first()

  if (!file) {
    return errorResponse('File not found', 404)
  }

  requireWorkspaceAccess(user, file.workspace_slug)

  if (!env.FILES) {
    return errorResponse('File storage not configured', 503)
  }

  const object = await env.FILES.get(file.r2_key)
  if (!object) {
    return errorResponse('File not found in storage', 404)
  }

  await logAudit(env, user.userId, 'file.download', {
    resourceType: 'file',
    resourceId: fileId,
    filename: file.filename,
    ipAddress: getClientIp(request),
  })

  // Notify on download
  const wsInfo = await env.DB.prepare('SELECT id, name FROM workspaces WHERE slug = ?').bind(file.workspace_slug).first()
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'file.download',
    workspaceId: wsInfo?.id || null,
    workspaceName: wsInfo?.name || file.workspace_slug,
    title: `File Downloaded: ${file.filename}`,
    bodyLines: [
      `<strong>File:</strong> ${file.filename}`,
      `<strong>Workspace:</strong> ${wsInfo?.name || file.workspace_slug}`,
      `<strong>Downloaded by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { fileId, filename: file.filename, workspaceSlug: file.workspace_slug },
  })

  return new Response(object.body, {
    headers: {
      'Content-Type': file.content_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.size_bytes?.toString() || '',
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
    },
  })
}

/**
 * PATCH /api/files/:id/move — move a file to a different folder
 * Body: { folder_id } (null = move to root)
 */
export async function handleMoveFile(request, env, user, params, ctx) {
  const file = await env.DB.prepare(
    `SELECT f.id, f.filename, f.workspace_id, f.folder_id, w.slug AS workspace_slug, w.name AS workspace_name
     FROM files f INNER JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = ?`,
  ).bind(params.id).first()
  if (!file) return errorResponse('File not found', 404)

  if (!hasWorkspaceWriteAccess(user, file.workspace_slug)) {
    throw errorResponse('Forbidden: write permission required', 403)
  }
  requireWorkspaceAccess(user, file.workspace_slug)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON body', 400) }

  const targetFolderId = body.folder_id === undefined ? file.folder_id : body.folder_id

  // Validate target folder
  if (targetFolderId) {
    const targetFolder = await env.DB.prepare('SELECT id, workspace_id FROM folders WHERE id = ?')
      .bind(targetFolderId).first()
    if (!targetFolder) return errorResponse('Target folder not found', 404)
    if (targetFolder.workspace_id !== file.workspace_id) {
      return errorResponse('Cannot move files across workspaces', 403)
    }
  }

  await env.DB.prepare("UPDATE files SET folder_id = ? WHERE id = ?")
    .bind(targetFolderId, file.id).run()

  await logAudit(env, user.userId, 'file.move', {
    resourceType: 'file',
    resourceId: file.id,
    filename: file.filename,
    fromFolderId: file.folder_id,
    toFolderId: targetFolderId,
    workspaceSlug: file.workspace_slug,
    ipAddress: getClientIp(request),
  })

  notifyWorkspaceEvent(env, ctx, {
    eventType: 'file.move',
    workspaceId: file.workspace_id,
    workspaceName: file.workspace_name,
    title: `File Moved: ${file.filename}`,
    bodyLines: [
      `<strong>File:</strong> ${file.filename}`,
      `<strong>Workspace:</strong> ${file.workspace_name}`,
      `<strong>Moved by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { fileId: file.id, filename: file.filename, fromFolderId: file.folder_id, toFolderId: targetFolderId },
  })

  return jsonResponse({ message: 'File moved', file: { id: file.id, folder_id: targetFolderId } })
}
