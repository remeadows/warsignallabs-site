// worker/src/routes/me.js
import { jsonResponse } from '../cors.js'

export async function handleHealth(request, env) {
  return jsonResponse({
    status: 'healthy',
    service: 'wsl-portal-api',
    timestamp: new Date().toISOString(),
    d1: !!env.DB,
    r2: !!env.FILES,
    clerkApi: !!env.CLERK_SECRET_KEY,
  })
}

/** GET /api/me — the authenticated user's D1 role, workspaces, and permissions. */
export async function handleMe(request, env, user) {
  return jsonResponse({
    userId: user.dbUserId || user.userId,
    role: user.role,
    workspaceSlugs: user.workspaceSlugs,
    workspacePermissions: user.workspacePermissions,
    email: user.email,
  })
}
