// worker/src/routes/admin.js
import { jsonResponse } from '../cors.js'
import { requireRole } from '../auth.js'

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Projects Data (embedded at deploy time — v0.2.2 file-based)
// Source: data/projects.json exported from Linear
// ═══════════════════════════════════════════════════════════════════════════════

export const DASHBOARD_PROJECTS_DATA = [
  { id: "01fa033a", title: "Client Portal (portal.warsignallabs.net)", category: "WebApps", priority: 1, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/client-portal-portalwarsignallabsnet-138ece1eddc9", repoUrl: null, targetDate: "2026-03-29" },
  { id: "b80d66d6", title: "WarSignalLabs Website Overhaul", category: "WebApps", priority: 2, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/warsignallabs-website-overhaul-fada6a147f0a", repoUrl: null, targetDate: null },
  { id: "688aa22d", title: "GridWatch Mac v1", category: "Enterprise", priority: 2, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gridwatch-mac-v1-5c38ba0c9596", repoUrl: null, targetDate: null },
  { id: "5dfbf971", title: "GridWatch Command — Board Authority Refactor", category: "Games", priority: 1, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gridwatch-command-board-authority-refactor-7a8ce8bd8469", repoUrl: null, targetDate: null },
  { id: "6369fdb3", title: "Blueprint Advisory LLC [CLIENT]", category: "Clients", priority: 3, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/blueprint-advisory-llc-client-a53076bfad33", repoUrl: null, targetDate: null },
  { id: "78b1b62f", title: "GridWatch NetEnterprise Modernization", category: "Enterprise", priority: 2, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gridwatch-netenterprise-modernization-6608c2842b99", repoUrl: null, targetDate: null },
  { id: "a16ca725", title: "GW-OS", category: "Infrastructure", priority: 2, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gw-os-d5ab09b59218", repoUrl: "https://github.com/remeadows/GW-OS", targetDate: "2026-03-31" },
  { id: "7cf2c18d", title: "AgentSkills", category: "Infrastructure", priority: 3, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/agentskills-4878687549d1", repoUrl: null, targetDate: null },
  { id: "1e3aa566", title: "MCP-Remote-Access", category: "MCP", priority: 3, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/mcp-remote-access-711d812b3ea0", repoUrl: "https://github.com/remeadows/MCP-Remote-Access", targetDate: null },
  { id: "863c2145", title: "WarSignalAir", category: "Games", priority: 3, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/warsignalair-3001079179ef", repoUrl: "https://github.com/remeadows/WarSignalAir", targetDate: null },
  { id: "d423e6ae", title: "GridWatchMatch", category: "Games", priority: 1, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gridwatchmatch-4f41f910febf", repoUrl: "https://github.com/remeadows/GridWatchMatch", targetDate: "2026-09-01" },
  { id: "f2807b35", title: "HomeGym", category: "Apps", priority: 2, status: "Planned", linearUrl: "https://linear.app/remeadows/project/homegym-fe850ceef127", repoUrl: "https://github.com/remeadows/HomeGym", targetDate: "2026-03-24" },
  { id: "a815fb5f", title: "SignalSiege", category: "Games", priority: 3, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/signalsiege-31a9116c84ff", repoUrl: "https://github.com/remeadows/SignalSiege", targetDate: null },
  { id: "c37aea96", title: "GitHub Security Review", category: "Security", priority: 1, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/github-security-review-cd8723229a25", repoUrl: null, targetDate: "2026-03-14" },
  { id: "92198b30", title: "Agency System Standup", category: "Infrastructure", priority: 1, status: "Backlog", linearUrl: "https://linear.app/remeadows/project/agency-system-standup-395ec9059e2d", repoUrl: null, targetDate: null },
  { id: "7d4812b7", title: "GridWatchZero Launch Stabilization", category: "Games", priority: 1, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/gridwatchzero-launch-stabilization-6c496a360042", repoUrl: null, targetDate: "2026-03-31" },
  { id: "fa41df01", title: "ClaudeArchitect", category: "Infrastructure", priority: 2, status: "In Progress", linearUrl: "https://linear.app/remeadows/project/claudearchitect-44aac9606f1f", repoUrl: "https://github.com/remeadows/ClaudeArchitect", targetDate: "2026-03-10" },
  { id: "2bf478cc", title: "ClaudeArchitect Hardening Plan", category: "Infrastructure", priority: 2, status: "Completed", linearUrl: "https://linear.app/remeadows/project/claudearchitect-hardening-plan-f3f36cf0ba38", repoUrl: null, targetDate: "2026-03-27" },
  { id: "ecbb7da8", title: "NetNynja Enterprise Stabilization", category: "Enterprise", priority: 3, status: "Completed", linearUrl: "https://linear.app/remeadows/project/netnynja-enterprise-stabilization-8daa0e0a5527", repoUrl: null, targetDate: null },
]

/**
 * GET /api/audit-log — admin only, returns audit log entries
 * D1 schema: audit_log(id, user_id, action, resource_type, resource_id, metadata_json, ip_address, created_at)
 */
export async function handleAuditLog(request, env, user) {
  requireRole(user, 'admin')

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
 * GET /api/admin/analytics — admin only, workspace stats and overview
 */
export async function handleAdminAnalytics(request, env, user) {
  requireRole(user, 'admin')

  const [
    workspaceStats,
    totalUsers,
    totalFiles,
    totalStorage,
    recentActivity,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT w.id, w.name, w.slug, w.color,
              (SELECT COUNT(*) FROM files f WHERE f.workspace_id = w.id) AS file_count,
              (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f WHERE f.workspace_id = w.id) AS total_bytes,
              (SELECT COUNT(*) FROM user_workspaces uw WHERE uw.workspace_id = w.id) AS member_count
       FROM workspaces w
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

/**
 * GET /api/dashboard/projects — admin only
 * Serves the operational dashboard projects list.
 * v0.2.2: file-based (embedded JSON). Future: D1-backed.
 */
export async function handleDashboardProjects(request, env, user) {
  requireRole(user, 'admin')

  // In v0.2.2, project data is embedded at deploy time from data/projects.json.
  // Future versions will read from D1 or fetch from Linear API.
  const url = new URL(request.url)
  const filterStatus = url.searchParams.get('status')
  const filterPriority = url.searchParams.get('priority')
  const filterCategory = url.searchParams.get('category')
  const sortBy = url.searchParams.get('sort') || 'priority'
  const sortOrder = url.searchParams.get('order') || 'asc'

  let projects = DASHBOARD_PROJECTS_DATA

  if (filterStatus) {
    projects = projects.filter(p => p.status === filterStatus)
  }
  if (filterPriority) {
    projects = projects.filter(p => String(p.priority) === filterPriority)
  }
  if (filterCategory) {
    projects = projects.filter(p => p.category === filterCategory)
  }

  projects = [...projects].sort((a, b) => {
    let aVal = a[sortBy]
    let bVal = b[sortBy]
    if (sortBy === 'priority') { aVal = aVal || 99; bVal = bVal || 99 }
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    return sortOrder === 'asc' ? (aVal || 0) - (bVal || 0) : (bVal || 0) - (aVal || 0)
  })

  return jsonResponse(
    { projects },
    200,
    { 'Cache-Control': 'private, max-age=3600' },
  )
}
