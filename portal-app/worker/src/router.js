// worker/src/router.js
// Path matching + the top-level fetch dispatch. Every route handler is a
// pure function imported from ./routes/*; this file only decides which one
// to call for a given method+pathname.

import { CORS_HEADERS, errorResponse } from './cors.js'
import { requireAuth } from './auth.js'
import {
  handleHealth,
  handleMe,
  handleListNotifications,
  handleMarkNotificationsRead,
  handleUpdatePreferences,
  handleMyTasks,
  handleMyActivity,
} from './routes/me.js'
import {
  handleListWorkspaces,
  handleGetWorkspace,
  handleCreateWorkspace,
  handleUpdateWorkspace,
  handleDeleteWorkspace,
  handleGetUserWorkspaces,
  handleUpdateUserWorkspaces,
  handleGetActivity,
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
import {
  handleListMembers,
  handleUpdateMemberPermission,
  handleRemoveMember,
  handleCreateInvitation,
  handleListInvitations,
  handleRevokeInvitation,
} from './routes/members.js'
import {
  handleListComments,
  handleCreateComment,
  handleEditComment,
  handleDeleteComment,
} from './routes/comments.js'
import {
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
} from './routes/projects.js'
import {
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleDeleteTask,
} from './routes/tasks.js'

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
        return await handleHealth(request, env)
      }

      if (pathname === '/api/briefs' && method === 'POST') {
        return await handlePostBrief(request, env)
      }

      if (pathname.startsWith('/api/')) {
        const user = await requireAuth(request, env)

        if (pathname === '/api/me' && method === 'GET') {
          return await handleMe(request, env, user)
        }

        if (pathname === '/api/workspaces' && method === 'GET') {
          return await handleListWorkspaces(request, env, user)
        }

        let params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'GET') {
          return await handleGetWorkspace(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/files', pathname)
        if (params && method === 'GET') {
          return await handleListFiles(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleUploadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id', pathname)
        if (params && method === 'PUT') {
          return await handleReplaceFile(request, env, user, params, ctx)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/download', pathname)
        if (params && method === 'GET') {
          return await handleDownloadFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/files/:id/versions', pathname)
        if (params && method === 'GET') {
          return await handleGetFileVersions(request, env, user, params)
        }

        params = matchPath('/api/files/:id/move', pathname)
        if (params && method === 'PATCH') {
          return await handleMoveFile(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders', pathname)
        if (params && method === 'GET') {
          return await handleListFolderContents(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/folders/:folderId', pathname)
        if (params && method === 'GET') {
          return await handleListFolderContents(request, env, user, params)
        }

        params = matchPath('/api/folders/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleRenameFolder(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/folders/:id/move', pathname)
        if (params && method === 'PATCH') {
          return await handleMoveFolder(request, env, user, params, ctx)
        }

        params = matchPath('/api/workspaces/:slug/activity', pathname)
        if (params && method === 'GET') {
          return await handleGetActivity(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/members', pathname)
        if (params && method === 'GET') {
          return await handleListMembers(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/members/:userId', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateMemberPermission(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleRemoveMember(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/invitations', pathname)
        if (params && method === 'GET') {
          return await handleListInvitations(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateInvitation(request, env, user, params, ctx)
        }

        params = matchPath('/api/invitations/:id', pathname)
        if (params && method === 'DELETE') {
          return await handleRevokeInvitation(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/comments', pathname)
        if (params && method === 'GET') {
          return await handleListComments(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateComment(request, env, user, params, ctx)
        }

        params = matchPath('/api/comments/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleEditComment(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteComment(request, env, user, params)
        }

        params = matchPath('/api/workspaces/:slug/projects', pathname)
        if (params && method === 'GET') {
          return await handleListProjects(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateProject(request, env, user, params)
        }

        params = matchPath('/api/projects/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateProject(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteProject(request, env, user, params)
        }

        params = matchPath('/api/projects/:id/tasks', pathname)
        if (params && method === 'GET') {
          return await handleListTasks(request, env, user, params)
        }
        if (params && method === 'POST') {
          return await handleCreateTask(request, env, user, params, ctx)
        }

        params = matchPath('/api/tasks/:id', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateTask(request, env, user, params, ctx)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteTask(request, env, user, params)
        }

        if (pathname === '/api/notifications' && method === 'GET') {
          return await handleListNotifications(request, env, user)
        }
        if (pathname === '/api/notifications/mark-read' && method === 'POST') {
          return await handleMarkNotificationsRead(request, env, user)
        }

        if (pathname === '/api/me/preferences' && method === 'PATCH') {
          return await handleUpdatePreferences(request, env, user)
        }

        if (pathname === '/api/me/tasks' && method === 'GET') {
          return await handleMyTasks(request, env, user)
        }

        if (pathname === '/api/me/activity' && method === 'GET') {
          return await handleMyActivity(request, env, user)
        }

        if (pathname === '/api/users' && method === 'GET') {
          return await handleListUsers(request, env, user)
        }

        if (pathname === '/api/users' && method === 'POST') {
          return await handleCreateUser(request, env, user, ctx)
        }

        params = matchPath('/api/users/:id/role', pathname)
        if (params && method === 'PATCH') {
          return await handleChangeRole(request, env, user, params)
        }

        params = matchPath('/api/users/:id/deactivate', pathname)
        if (params && method === 'POST') {
          return await handleDeactivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/activate', pathname)
        if (params && method === 'POST') {
          return await handleActivateUser(request, env, user, params)
        }

        params = matchPath('/api/users/:id/workspaces', pathname)
        if (params && method === 'GET') {
          return await handleGetUserWorkspaces(request, env, user, params)
        }
        if (params && method === 'PATCH') {
          return await handleUpdateUserWorkspaces(request, env, user, params)
        }

        if (pathname === '/api/workspaces' && method === 'POST') {
          return await handleCreateWorkspace(request, env, user)
        }

        params = matchPath('/api/workspaces/:slug', pathname)
        if (params && method === 'PATCH') {
          return await handleUpdateWorkspace(request, env, user, params)
        }
        if (params && method === 'DELETE') {
          return await handleDeleteWorkspace(request, env, user, params)
        }

        if (pathname === '/api/audit-log' && method === 'GET') {
          return await handleAuditLog(request, env, user)
        }

        if (pathname === '/api/admin/analytics' && method === 'GET') {
          return await handleAdminAnalytics(request, env, user)
        }

        if (pathname === '/api/dashboard/projects' && method === 'GET') {
          return await handleDashboardProjects(request, env, user)
        }

        if (pathname === '/api/briefs/latest' && method === 'GET') {
          return await handleGetLatestBrief(request, env, user)
        }
        if (pathname === '/api/briefs' && method === 'GET') {
          return await handleListBriefs(request, env, user)
        }
        const briefDateMatch = pathname.match(/^\/api\/briefs\/(\d{4}-\d{2}-\d{2})$/)
        if (briefDateMatch && method === 'GET') {
          return await handleGetBrief(request, env, user, briefDateMatch[1])
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
