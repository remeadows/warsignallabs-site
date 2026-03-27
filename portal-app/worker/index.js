/**
 * WarSignalLabs Portal API Worker
 * Cloudflare Worker handling auth, RBAC, file management, and audit logging.
 *
 * Bindings (configured in wrangler.toml):
 *   - DB: D1 database (wsl-portal)
 *   - FILES: R2 bucket (wsl-portal-files)
 *   - CLERK_SECRET_KEY: secret (for Backend API user lookup)
 *   - CLERK_FRONTEND_API: var (e.g., https://sharing-gator-67.clerk.accounts.dev)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Constants & Shared Headers
// ═══════════════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

// ═══════════════════════════════════════════════════════════════════════════════
// Response Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
    },
  })
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status)
}

// ═══════════════════════════════════════════════════════════════════════════════
// JWT Verification (RS256 via Web Crypto API)
// ═══════════════════════════════════════════════════════════════════════════════

let jwksCache = null
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000

async function getJwks(env) {
  const now = Date.now()
  if (jwksCache && (now - jwksCache.fetchedAt) < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys
  }

  const frontendApi = env.CLERK_FRONTEND_API
  if (!frontendApi) {
    throw new Error('CLERK_FRONTEND_API environment variable is not configured')
  }

  const url = `${frontendApi}/.well-known/jwks.json`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  jwksCache = { keys: data.keys, fetchedAt: now }
  return data.keys
}

function base64urlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4 !== 0) {
    base64 += '='
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeJwt(token) {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: expected 3 parts')
  }

  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])))
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])))
  const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64urlDecode(parts[2])

  return { header, payload, signatureInput, signature }
}

async function importJwk(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

async function verifyJwt(token, env) {
  const { header, payload, signatureInput, signature } = decodeJwt(token)

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`)
  }

  const keys = await getJwks(env)
  const matchingKey = keys.find((k) => k.kid === header.kid)
  if (!matchingKey) {
    jwksCache = null
    const freshKeys = await getJwks(env)
    const retryKey = freshKeys.find((k) => k.kid === header.kid)
    if (!retryKey) {
      throw new Error(`No matching JWKS key found for kid: ${header.kid}`)
    }
    const cryptoKey = await importJwk(retryKey)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signatureInput)
    if (!valid) throw new Error('JWT signature verification failed')
  } else {
    const cryptoKey = await importJwk(matchingKey)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signatureInput)
    if (!valid) throw new Error('JWT signature verification failed')
  }

  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) {
    throw new Error('JWT has expired')
  }
  if (payload.nbf && payload.nbf > now + 60) {
    throw new Error('JWT is not yet valid')
  }

  return payload
}

// ═══════════════════════════════════════════════════════════════════════════════
// Clerk Backend API — resolve user metadata from Clerk
// ═══════════════════════════════════════════════════════════════════════════════

/** In-memory cache: clerkUserId -> { role, workspaceSlugs, email, username, cachedAt } */
const clerkUserCache = new Map()
const CLERK_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch user metadata from Clerk Backend API.
 * Requires CLERK_SECRET_KEY to be set as a worker secret.
 */
async function fetchClerkUser(clerkUserId, env) {
  const now = Date.now()
  const cached = clerkUserCache.get(clerkUserId)
  if (cached && (now - cached.cachedAt) < CLERK_CACHE_TTL_MS) {
    return cached
  }

  if (!env.CLERK_SECRET_KEY) {
    return null
  }

  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    })
    if (!response.ok) {
      console.error(`Clerk API error for ${clerkUserId}: ${response.status}`)
      return null
    }
    const data = await response.json()
    const publicMetadata = data.public_metadata || {}
    const result = {
      role: publicMetadata.role || 'client',
      workspaceSlugs: publicMetadata.workspace_slugs || [],
      email: data.email_addresses?.[0]?.email_address || null,
      username: data.username || null,
      cachedAt: now,
    }
    clerkUserCache.set(clerkUserId, result)
    return result
  } catch (err) {
    console.error('Clerk API fetch failed:', err.message)
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auth & RBAC Middleware
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract and verify the Bearer token from the request.
 * Returns a user object with { userId, role, workspaceSlugs, email, dbUserId, claims }.
 *
 * Role resolution order:
 *   1. JWT publicMetadata (if Clerk session token template is configured)
 *   2. D1 users table lookup by clerk_id
 *   3. Clerk Backend API (if CLERK_SECRET_KEY is set)
 *   4. Default to 'client' role
 */
async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw errorResponse('Missing or invalid Authorization header', 401)
  }

  const token = authHeader.slice(7)
  if (!token) {
    throw errorResponse('Empty bearer token', 401)
  }

  let payload
  try {
    payload = await verifyJwt(token, env)
  } catch (err) {
    throw errorResponse(`Authentication failed: ${err.message}`, 401)
  }

  const clerkUserId = payload.sub

  // 1. Try JWT claims (if session token template includes publicMetadata)
  const publicMetadata = payload.publicMetadata || payload.metadata?.publicMetadata || {}
  let role = publicMetadata.role || null
  let workspaceSlugs = publicMetadata.workspace_slugs || null

  // Track the D1 user.id for foreign key references
  let dbUserId = null

  // 2. Always try D1 lookup to resolve dbUserId (needed for audit log + file FK)
  const dbUser = await env.DB.prepare(
    'SELECT id, role, username, email FROM users WHERE clerk_id = ?',
  )
    .bind(clerkUserId)
    .first()

  if (dbUser) {
    dbUserId = dbUser.id
    role = role || dbUser.role
    if (!workspaceSlugs) {
      const wsResult = await env.DB.prepare(
        `SELECT w.slug FROM workspaces w
         INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
         WHERE uw.user_id = ?`,
      )
        .bind(dbUser.id)
        .all()
      workspaceSlugs = wsResult.results.map((r) => r.slug)
    }
  }

  // 3. If no D1 match by clerk_id, try matching by email to auto-map
  if (!dbUserId) {
    // Collect email candidates from JWT and Clerk API
    const emailCandidates = [
      payload.email,
      payload.primaryEmail,
    ].filter(Boolean)

    // Also try Clerk Backend API for email
    if (emailCandidates.length === 0 && !role) {
      const clerkUser = await fetchClerkUser(clerkUserId, env)
      if (clerkUser) {
        role = role || clerkUser.role
        workspaceSlugs = workspaceSlugs || clerkUser.workspaceSlugs
        if (clerkUser.email) emailCandidates.push(clerkUser.email)
      }
    }

    for (const email of emailCandidates) {
      const matched = await env.DB.prepare(
        'SELECT id, role FROM users WHERE LOWER(email) = LOWER(?)',
      )
        .bind(email)
        .first()
      if (matched) {
        dbUserId = matched.id
        role = role || matched.role
        await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
          .bind(clerkUserId, matched.id).run()
        console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via email`)
        break
      }
    }

    // 4. If still no match, try Clerk username → D1 username
    if (!dbUserId) {
      const clerkUsername = publicMetadata.username || payload.username || null
      if (clerkUsername) {
        const matched = await env.DB.prepare(
          'SELECT id, role FROM users WHERE username = ?',
        ).bind(clerkUsername).first()
        if (matched) {
          dbUserId = matched.id
          role = role || matched.role
          await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
            .bind(clerkUserId, matched.id).run()
          console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via username`)
        }
      }
    }
  }

  return {
    userId: clerkUserId,
    dbUserId: dbUserId,
    role: role || 'client',
    workspaceSlugs: workspaceSlugs || [],
    email: payload.email || null,
    claims: payload,
  }
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw errorResponse(
      `Forbidden: requires one of [${roles.join(', ')}], you have [${user.role}]`,
      403,
    )
  }
}

function requireWorkspaceAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') {
    return
  }
  if (!user.workspaceSlugs.includes(workspaceSlug)) {
    throw errorResponse('Forbidden: you do not have access to this workspace', 403)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audit Logging
// ═══════════════════════════════════════════════════════════════════════════════

async function logAudit(env, userId, action, details = {}) {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        id,
        userId,
        action,
        details.resourceType || null,
        details.resourceId || null,
        JSON.stringify(details),
        details.ipAddress || null,
      )
      .run()
  } catch (err) {
    console.error('Audit log write failed:', err.message)
  }
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}

// ═══════════════════════════════════════════════════════════════════════════════
// Route Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/')
  const pathParts = pathname.split('/')

  if (patternParts.length !== pathParts.length) {
    return null
  }

  const params = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i])
    } else if (patternParts[i] !== pathParts[i]) {
      return null
    }
  }
  return params
}

// ═══════════════════════════════════════════════════════════════════════════════
// Route Handlers
// ═══════════════════════════════════════════════════════════════════════════════

async function handleHealth(request, env) {
  return jsonResponse({
    status: 'healthy',
    service: 'wsl-portal-api',
    timestamp: new Date().toISOString(),
    d1: !!env.DB,
    r2: !!env.FILES,
    clerkApi: !!env.CLERK_SECRET_KEY,
  })
}

/**
 * GET /api/workspaces — returns workspaces filtered by user access
 */
async function handleListWorkspaces(request, env, user) {
  let workspaces

  if (user.role === 'admin' || user.role === 'owner') {
    const result = await env.DB.prepare(
      'SELECT id, name, slug, color, created_at FROM workspaces ORDER BY name',
    ).all()
    workspaces = result.results
  } else {
    // Client: filter by workspace_slugs from auth
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
async function handleGetWorkspace(request, env, user, params) {
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
    workspaceSlug: params.slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({
    workspace: {
      ...workspace,
      memberCount: memberCount?.count || 0,
      fileCount: fileCount?.count || 0,
    },
  })
}

/**
 * GET /api/workspaces/:slug/files — returns files for a workspace
 * D1 schema: files(id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
 */
async function handleListFiles(request, env, user, params) {
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
    query = `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.created_at,
                    u.username AS uploaded_by_name
             FROM files f
             LEFT JOIN users u ON u.clerk_id = f.uploaded_by OR u.id = f.uploaded_by
             WHERE f.workspace_id = ? AND f.category = ?
             ORDER BY f.created_at DESC
             LIMIT ? OFFSET ?`
    bindings = [workspace.id, category, limit, offset]
  } else {
    query = `SELECT f.id, f.filename, f.r2_key, f.size_bytes, f.content_type, f.category, f.created_at,
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
 * Allowed MIME types for upload.
 */
const ALLOWED_MIME_TYPES = new Set([
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

const VALID_CATEGORIES = new Set(['invoices', 'documents', 'deliverables', 'reports'])
const MAX_FILE_SIZE = 50 * 1024 * 1024

/**
 * POST /api/workspaces/:slug/files — upload a file via multipart/form-data.
 * D1 schema: files(id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
 */
async function handleUploadFile(request, env, user, params) {
  requireRole(user, 'admin', 'owner')
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

  // Record in D1 (schema: id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by)
  await env.DB.prepare(
    `INSERT INTO files (id, workspace_id, category, filename, r2_key, size_bytes, content_type, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(fileId, workspace.id, category, sanitized, r2Key, file.size, file.type, uploadedBy)
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
      },
      message: 'File uploaded successfully',
    },
    201,
  )
}

/**
 * DELETE /api/files/:id — admin only
 */
async function handleDeleteFile(request, env, user, params) {
  requireRole(user, 'admin')

  const fileId = params.id

  const file = await env.DB.prepare(
    'SELECT id, filename, r2_key, workspace_id FROM files WHERE id = ?',
  )
    .bind(fileId)
    .first()

  if (!file) {
    return errorResponse('File not found', 404)
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

  return jsonResponse({ message: 'File deleted', fileId })
}

/**
 * GET /api/files/:id/download — stream from R2
 * D1 schema: content_type (not mime_type)
 */
async function handleDownloadFile(request, env, user, params) {
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
 * GET /api/users — admin/owner, lists all users from D1
 */
async function handleListUsers(request, env, user) {
  requireRole(user, 'admin', 'owner')

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
 * GET /api/audit-log — admin/owner, returns audit log entries
 * D1 schema: audit_log(id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)
 */
async function handleAuditLog(request, env, user) {
  requireRole(user, 'admin', 'owner')

  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)
  const action = url.searchParams.get('action')
  const filterUserId = url.searchParams.get('user_id')

  let query = `SELECT a.id, a.user_id, a.action, a.resource_type, a.resource_id,
                      a.metadata_json, a.ip_address, a.created_at,
                      u.username AS user_name
               FROM audit_log a
               LEFT JOIN users u ON u.clerk_id = a.user_id OR u.id = a.user_id`

  const conditions = []
  const bindings = []

  if (action) {
    conditions.push('a.action = ?')
    bindings.push(action)
  }
  if (filterUserId) {
    conditions.push('a.user_id = ?')
    bindings.push(filterUserId)
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`
  }

  query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?'
  bindings.push(limit, offset)

  const result = await env.DB.prepare(query).bind(...bindings).all()

  const entries = result.results.map((entry) => ({
    ...entry,
    details: entry.metadata_json ? JSON.parse(entry.metadata_json) : null,
  }))

  return jsonResponse({
    entries,
    pagination: { limit, offset },
  })
}

/**
 * GET /api/admin/analytics — admin/owner, workspace stats and overview
 */
async function handleAdminAnalytics(request, env, user) {
  requireRole(user, 'admin', 'owner')

  const [
    workspaceStats,
    totalUsers,
    totalFiles,
    totalStorage,
    recentActivity,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT w.id, w.name, w.slug, w.color,
              COUNT(f.id) AS file_count,
              COALESCE(SUM(f.size_bytes), 0) AS total_bytes,
              COUNT(DISTINCT uw.user_id) AS member_count
       FROM workspaces w
       LEFT JOIN files f ON f.workspace_id = w.id
       LEFT JOIN user_workspaces uw ON uw.workspace_id = w.id
       GROUP BY w.id
       ORDER BY total_bytes DESC`,
    ).all(),

    env.DB.prepare('SELECT COUNT(*) AS count FROM users').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM files').first(),
    env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files').first(),

    env.DB.prepare(
      `SELECT a.action, a.resource_type, a.created_at, u.username AS user_name
       FROM audit_log a
       LEFT JOIN users u ON u.clerk_id = a.user_id OR u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT 10`,
    ).all(),
  ])

  return jsonResponse({
    overview: {
      totalWorkspaces: workspaceStats.results.length,
      totalUsers: totalUsers?.count || 0,
      totalFiles: totalFiles?.count || 0,
      totalStorageBytes: totalStorage?.total || 0,
    },
    workspaces: workspaceStats.results,
    recentActivity: recentActivity.results,
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Admin Management Handlers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/users/:id/deactivate — admin/owner only
 */
async function handleDeactivateUser(request, env, user, params) {
  requireRole(user, 'admin', 'owner')
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
async function handleActivateUser(request, env, user, params) {
  requireRole(user, 'admin', 'owner')
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

/**
 * GET /api/users/:id/workspaces — get workspace assignments for a user
 */
async function handleGetUserWorkspaces(request, env, user, params) {
  requireRole(user, 'admin', 'owner')
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
async function handleUpdateUserWorkspaces(request, env, user, params) {
  requireRole(user, 'admin', 'owner')
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

/**
 * POST /api/workspaces — create a new workspace (admin only)
 */
async function handleCreateWorkspace(request, env, user) {
  requireRole(user, 'admin')

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

  const { name, slug, color } = body
  if (!name || !slug) return errorResponse('name and slug are required', 400)

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse('slug must be lowercase alphanumeric with hyphens only', 400)
  }

  // Check uniqueness
  const existing = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?')
    .bind(slug).first()
  if (existing) return errorResponse('A workspace with this slug already exists', 409)

  const wsId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, slug, color, storage_quota_mb, storage_used_mb, created_at, updated_at)
     VALUES (?, ?, ?, ?, 2048, 0, datetime('now'), datetime('now'))`,
  ).bind(wsId, name, slug, color || '#00c8d4').run()

  await logAudit(env, user.userId, 'workspace.create', {
    resourceType: 'workspace', resourceId: wsId,
    name, slug, ipAddress: getClientIp(request),
  })

  return jsonResponse({ workspace: { id: wsId, name, slug, color: color || '#00c8d4' } }, 201)
}

/**
 * PATCH /api/workspaces/:slug — update workspace (admin only)
 */
async function handleUpdateWorkspace(request, env, user, params) {
  requireRole(user, 'admin')

  const workspace = await env.DB.prepare('SELECT id, name, slug, color FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }

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
    slug: params.slug, changes: Object.keys(body),
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace updated', slug: params.slug })
}

/**
 * DELETE /api/workspaces/:slug — admin only, deletes workspace + files + assignments
 */
async function handleDeleteWorkspace(request, env, user, params) {
  requireRole(user, 'admin')

  const workspace = await env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE slug = ?')
    .bind(params.slug).first()
  if (!workspace) return errorResponse('Workspace not found', 404)

  // Delete files from R2
  const files = await env.DB.prepare('SELECT r2_key FROM files WHERE workspace_id = ?')
    .bind(workspace.id).all()
  for (const f of files.results) {
    try { await env.FILES.delete(f.r2_key) } catch { /* continue */ }
  }

  // Delete D1 records: files, user_workspaces, then workspace
  await env.DB.prepare('DELETE FROM files WHERE workspace_id = ?').bind(workspace.id).run()
  await env.DB.prepare('DELETE FROM user_workspaces WHERE workspace_id = ?').bind(workspace.id).run()
  await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspace.id).run()

  await logAudit(env, user.userId, 'workspace.delete', {
    resourceType: 'workspace', resourceId: workspace.id,
    name: workspace.name, slug: workspace.slug,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Workspace deleted', slug: params.slug })
}

/**
 * POST /api/users — admin only, create a new user in D1
 * Body: { username, email, role }
 */
async function handleCreateUser(request, env, user) {
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

  return jsonResponse({
    user: { id: userId, username, email, role: newRole || 'client', status: 'active' },
    message: 'User created',
  }, 201)
}

/**
 * PATCH /api/users/:id/role — admin only, change user role
 * Body: { role: 'admin' | 'owner' | 'client' }
 */
async function handleChangeRole(request, env, user, params) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      // ── Public Routes ──

      if (pathname === '/api/health' && method === 'GET') {
        return handleHealth(request, env)
      }

      // ── Authenticated Routes ──

      if (pathname.startsWith('/api/')) {
        const user = await requireAuth(request, env)

        if (pathname === '/api/workspaces' && method === 'GET') {
          return handleListWorkspaces(request, env, user)
        }

        let params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'GET') {
          return handleGetWorkspace(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/files', pathname)
        if (params && method === 'GET') {
          return handleListFiles(request, env, user, params)
        }
        if (params && method === 'POST') {
          return handleUploadFile(request, env, user, params)
        }

        params = matchPath('/api/files/:id', pathname)
        if (params && method === 'DELETE') {
          return handleDeleteFile(request, env, user, params)
        }

        params = matchPath('/api/files/:id/download', pathname)
        if (params && method === 'GET') {
          return handleDownloadFile(request, env, user, params)
        }

        if (pathname === '/api/users' && method === 'GET') {
          return handleListUsers(request, env, user)
        }

        // POST /api/users (create)
        if (pathname === '/api/users' && method === 'POST') {
          return handleCreateUser(request, env, user)
        }

        // PATCH /api/users/:id/role
        params = matchPath('/api/users/:id/role', pathname)
        if (params && method === 'PATCH') {
          return handleChangeRole(request, env, user, params)
        }

        // POST /api/users/:id/deactivate
        params = matchPath('/api/users/:id/deactivate', pathname)
        if (params && method === 'POST') {
          return handleDeactivateUser(request, env, user, params)
        }

        // POST /api/users/:id/activate
        params = matchPath('/api/users/:id/activate', pathname)
        if (params && method === 'POST') {
          return handleActivateUser(request, env, user, params)
        }

        // GET/PATCH /api/users/:id/workspaces
        params = matchPath('/api/users/:id/workspaces', pathname)
        if (params && method === 'GET') {
          return handleGetUserWorkspaces(request, env, user, params)
        }
        if (params && method === 'PATCH') {
          return handleUpdateUserWorkspaces(request, env, user, params)
        }

        // POST /api/workspaces (create)
        if (pathname === '/api/workspaces' && method === 'POST') {
          return handleCreateWorkspace(request, env, user)
        }

        // PATCH /api/workspaces/:slug (update)
        params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'PATCH') {
          return handleUpdateWorkspace(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return handleDeleteWorkspace(request, env, user, params)
        }

        if (pathname === '/api/audit-log' && method === 'GET') {
          return handleAuditLog(request, env, user)
        }

        if (pathname === '/api/admin/analytics' && method === 'GET') {
          return handleAdminAnalytics(request, env, user)
        }

        return errorResponse('Not found', 404)
      }

      return errorResponse('Not found', 404)
    } catch (err) {
      if (err instanceof Response) {
        return err
      }

      console.error('Unhandled error:', err.message, err.stack)
      return errorResponse('Internal server error', 500)
    }
  },
}
