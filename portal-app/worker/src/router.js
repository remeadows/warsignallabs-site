// worker/src/router.js
// Path matching + the top-level fetch dispatch. Every route handler is a
// pure function imported from ./routes/*; this file only decides which one
// to call for a given method+pathname.

import { CORS_HEADERS, errorResponse } from './cors.js'
import { requireAuth } from './auth.js'
import { handleHealth, handleMe } from './routes/me.js'
import {
  handleListWorkspaces,
  handleGetWorkspace,
  handleCreateWorkspace,
  handleUpdateWorkspace,
  handleDeleteWorkspace,
  handleGetUserWorkspaces,
  handleUpdateUserWorkspaces,
} from './routes/workspaces.js'
import {
  handleListFiles,
  handleUploadFile,
  handleReplaceFile,
  handleGetFileVersions,
  handleDeleteFile,
  handleDownloadFile,
  handleMoveFile,
} from './routes/files.js'
import {
  handleListFolderContents,
  handleCreateFolder,
  handleRenameFolder,
  handleDeleteFolder,
  handleMoveFolder,
} from './routes/folders.js'
import {
  handleListUsers,
  handleCreateUser,
  handleChangeRole,
  handleDeactivateUser,
  handleActivateUser,
} from './routes/users.js'
import {
  handleAuditLog,
  handleAdminAnalytics,
  handleDashboardProjects,
} from './routes/admin.js'
import {
  handlePostBrief,
  handleListBriefs,
  handleGetLatestBrief,
  handleGetBrief,
} from './routes/briefs.js'

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    try {
      if (pathname === '/api/health' && method === 'GET') {
        return handleHealth(request, env)
      }

      if (pathname === '/api/briefs' && method === 'POST') {
        return handlePostBrief(request, env)
      }

      if (pathname.startsWith('/api/')) {
        const user = await requireAuth(request, env)

        if (pathname === '/api/me' && method === 'GET') {
          return handleMe(request, env, user)
        }

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

        params = matchPath('/api/files/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }
        if (params && method === 'POST') {
          return handleCreateFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders/:folderId', pathname)
        if (params && method === 'GET') {
          return handleListFolderContents(request, env, user, params)
        }

        params = matchPath('/api/folders/:id', pathname)
        if (params && method === 'PATCH') {
          return handleRenameFolder(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return handleDeleteFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/folders/:id/move', pathname)
        if (params && method === 'PATCH') {
          return handleMoveFolder(request, env, user, params, ctx)
        }

        if (pathname === '/api/users' && method === 'GET') {
          return handleListUsers(request, env, user)
        }

        if (pathname === '/api/users' && method === 'POST') {
          return handleCreateUser(request, env, user, ctx)
        }

        params = matchPath('/api/users/:id/role', pathname)
        if (params && method === 'PATCH') {
          return handleChangeRole(request, env, user, params)
        }

        params = matchPath('/api/users/:id/deactivate', pathname)
        if (params && method === 'POST') {
          return handleDeactivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/activate', pathname)
        if (params && method === 'POST') {
          return handleActivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/workspaces', pathname)
        if (params && method === 'GET') {
          return handleGetUserWorkspaces(request, env, user, params)
        }
        if (params && method === 'PATCH') {
          return handleUpdateUserWorkspaces(request, env, user, params)
        }

        if (pathname === '/api/workspaces' && method === 'POST') {
          return handleCreateWorkspace(request, env, user)
        }

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

        if (pathname === '/api/dashboard/projects' && method === 'GET') {
          return handleDashboardProjects(request, env, user)
        }

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
