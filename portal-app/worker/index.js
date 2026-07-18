/**
 * WarSignalLabs Portal API Worker
 * Cloudflare Worker handling auth, RBAC, file management, and audit logging.
 *
 * Bindings (configured in wrangler.toml):
 *   - DB: D1 database (wsl-portal)
 *   - FILES: R2 bucket (wsl-portal-files)
 *   - CLERK_SECRET_KEY: secret (for Backend API user lookup)
 *   - CLERK_FRONTEND_API: var (e.g., https://sharing-gator-67.clerk.accounts.dev)
 *   - RESEND_API_KEY: secret (for email notifications via Resend)
 *   - RESEND_FROM_EMAIL: var (sender address)
 *   - RESEND_FROM_NAME: var (sender display name)
 */

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

      // ── GW-OS Service Key Routes (no Clerk session) ──

      if (pathname === '/api/briefs' && method === 'POST') {
        return handlePostBrief(request, env)
      }

      // ── Authenticated Routes ──

      if (pathname.startsWith('/api/')) {
        const user = await requireAuth(request, env)

        // /api/me handled via handleMe (Task 7 wires this call in)

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
          return handleUploadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id', pathname)
        if (params && method === 'PUT') {
          return handleReplaceFile(request, env, user, params, ctx)
        }
        if (params && method === 'DELETE') {
          return handleDeleteFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/download', pathname)
        if (params && method === 'GET') {
          return handleDownloadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/versions', pathname)
        if (params && method === 'GET') {
          return handleGetFileVersions(request, env, user, params)
        }

        // PATCH /api/files/:id/move
        params = matchPath('/api/files/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFile(request, env, user, params, ctx)
        }

        // GET /api/workspaces/:slug/folders (root listing)
        params = matchPath('/api/workspaces/:slug/folders', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }
        // POST /api/workspaces/:slug/folders (create folder)
        if (params && method === 'POST') {
          return handleCreateFolder(request, env, user, params, ctx)
        }

        // GET /api/workspaces/:slug/folders/:folderId (folder contents)
        params = matchPath('/api/workspaces/:slug/folders/:folderId', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }

        // PATCH /api/folders/:id (rename)
        params = matchPath('/api/folders/:id', pathname)
        if (params && method === 'PATCH') {
          return handleRenameFolder(request, env, user, params)
        }
        // DELETE /api/folders/:id
        if (params && method === 'DELETE') {
          return handleDeleteFolder(request, env, user, params, ctx)
        }

        // PATCH /api/folders/:id/move
        params = matchPath('/api/folders/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFolder(request, env, user, params, ctx)
        }

        if (pathname === '/api/users' && method === 'GET') {
          return handleListUsers(request, env, user)
        }

        // POST /api/users (create)
        if (pathname === '/api/users' && method === 'POST') {
          return handleCreateUser(request, env, user, ctx)
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

        // ── Operational Dashboard ──

        if (pathname === '/api/dashboard/projects' && method === 'GET') {
          return handleDashboardProjects(request, env, user)
        }

        // ── GW-OS Briefs (read) ──

        if (pathname === '/api/briefs/latest' && method === 'GET') {
          return handleGetLatestBrief(request, env, user)
        }
        if (pathname === '/api/briefs' && method === 'GET') {
          return handleListBriefs(request, env, user)
        }
        const briefDateMatch = pathname.match(/^\/api\/briefs\/(\d{4}-\d{2}-\d{2})$/)
        if (briefDateMatch && method === 'GET') {
          return handleGetBrief(request, env, user, briefDateMatch[1])
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
