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
// Constants & Shared Headers
// ═══════════════════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard Projects Data (embedded at deploy time — v0.2.2 file-based)
// Source: data/projects.json exported from Linear
// ═══════════════════════════════════════════════════════════════════════════════

const DASHBOARD_PROJECTS_DATA = [
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

// ═══════════════════════════════════════════════════════════════════════════════
// Response Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      ...extraHeaders,
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

  // JWT claims — used as fallback only when user is NOT in D1
  const publicMetadata = payload.publicMetadata || payload.metadata?.publicMetadata || {}

  // Track the D1 user.id for foreign key references
  let dbUserId = null
  let role = null
  let workspaceSlugs = null
  let workspacePermissions = null

  // 1. D1 is authoritative — always try D1 lookup first (by clerk_id)
  const dbUser = await env.DB.prepare(
    'SELECT id, role, username, email, status FROM users WHERE clerk_id = ?',
  )
    .bind(clerkUserId)
    .first()

  if (dbUser) {
    // Block deactivated accounts
    if (dbUser.status === 'inactive') {
      throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
    }
    dbUserId = dbUser.id
    // D1 role is authoritative — overrides Clerk publicMetadata
    role = dbUser.role
    // Always load workspace assignments + permissions from D1
    const wsResult = await env.DB.prepare(
      `SELECT w.slug, uw.permission FROM workspaces w
       INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
       WHERE uw.user_id = ?`,
    )
      .bind(dbUser.id)
      .all()
    workspaceSlugs = wsResult.results.map((r) => r.slug)
    workspacePermissions = {}
    for (const r of wsResult.results) {
      workspacePermissions[r.slug] = r.permission || 'read'
    }
  }

  // 2. If no D1 match by clerk_id, try matching by email to auto-map
  if (!dbUserId) {
    const emailCandidates = [
      payload.email,
      payload.primaryEmail,
    ].filter(Boolean)

    // Try Clerk Backend API for email if no candidates yet
    if (emailCandidates.length === 0) {
      const clerkUser = await fetchClerkUser(clerkUserId, env)
      if (clerkUser) {
        if (clerkUser.email) emailCandidates.push(clerkUser.email)
      }
    }

    for (const email of emailCandidates) {
      const matched = await env.DB.prepare(
        'SELECT id, role, status FROM users WHERE LOWER(email) = LOWER(?)',
      )
        .bind(email)
        .first()
      if (matched) {
        if (matched.status === 'inactive') {
          throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
        }
        dbUserId = matched.id
        role = matched.role  // D1 is authoritative
        await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
          .bind(clerkUserId, matched.id).run()
        console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via email`)

        // Always load workspace assignments + permissions from D1
        const wsResult = await env.DB.prepare(
          `SELECT w.slug, uw.permission FROM workspaces w
           INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
           WHERE uw.user_id = ?`,
        )
          .bind(matched.id)
          .all()
        workspaceSlugs = wsResult.results.map((r) => r.slug)
        workspacePermissions = {}
        for (const r of wsResult.results) {
          workspacePermissions[r.slug] = r.permission || 'read'
        }
        break
      }
    }

    // 3. If still no match, try Clerk username → D1 username
    if (!dbUserId) {
      const clerkUsername = publicMetadata.username || payload.username || null
      if (clerkUsername) {
        const matched = await env.DB.prepare(
          'SELECT id, role, status FROM users WHERE username = ?',
        ).bind(clerkUsername).first()
        if (matched) {
          if (matched.status === 'inactive') {
            throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
          }
          dbUserId = matched.id
          role = matched.role  // D1 is authoritative
          await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
            .bind(clerkUserId, matched.id).run()
          console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via username`)

          const wsResult = await env.DB.prepare(
            `SELECT w.slug, uw.permission FROM workspaces w
             INNER JOIN user_workspaces uw ON uw.workspace_id = w.id
             WHERE uw.user_id = ?`,
          )
            .bind(matched.id)
            .all()
          workspaceSlugs = wsResult.results.map((r) => r.slug)
          workspacePermissions = {}
          for (const r of wsResult.results) {
            workspacePermissions[r.slug] = r.permission || 'read'
          }
        }
      }
    }

    // 4. No D1 match at all — fall back to Clerk publicMetadata
    if (!dbUserId) {
      role = publicMetadata.role || null
      workspaceSlugs = publicMetadata.workspace_slugs || null
    }
  }

  return {
    userId: clerkUserId,
    dbUserId: dbUserId,
    role: role || 'client',
    workspaceSlugs: workspaceSlugs || [],
    workspacePermissions: workspacePermissions || {},
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

/**
 * Check if user has write-level (or higher) permission on a specific workspace.
 * Returns true for admin/owner roles (global access) or clients with 'write'/'admin' workspace permission.
 */
function hasWorkspaceWriteAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') return true
  const perm = (user.workspacePermissions || {})[workspaceSlug]
  return perm === 'write' || perm === 'admin'
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
// Email Notifications (Resend)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send an email via Resend API. Fire-and-forget — never blocks the primary action.
 * Logs to the notifications table for auditing.
 */
async function sendEmail(env, { to, subject, html, text, eventType, workspaceId, recipientUserId, metadata }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email notification')
    return null
  }

  const fromEmail = env.RESEND_FROM_EMAIL || 'portal@warsignallabs.net'
  const fromName = env.RESEND_FROM_NAME || 'WarSignalLabs Portal'

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || undefined,
        text: text || subject,
      }),
    })

    const result = await response.json()
    const resendId = result.id || null
    const status = response.ok ? 'sent' : 'failed'

    if (!response.ok) {
      console.error('Resend API error:', JSON.stringify(result))
    }

    // Log notification to D1
    const notifId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO notifications (id, event_type, workspace_id, recipient_email, recipient_user_id, subject, body_text, metadata_json, status, resend_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      notifId,
      eventType || 'general',
      workspaceId || null,
      Array.isArray(to) ? to.join(', ') : to,
      recipientUserId || null,
      subject,
      text || subject,
      metadata ? JSON.stringify(metadata) : null,
      status,
      resendId,
    ).run()

    return { id: resendId, status }
  } catch (err) {
    console.error('Email send failed:', err.message)
    return null
  }
}

/**
 * Resolve notification recipients for a workspace event.
 * Returns { admins: [{email, userId}], workspaceMembers: [{email, userId}] }
 */
async function resolveRecipients(env, workspaceId) {
  // All active admins
  const admins = await env.DB.prepare(
    "SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL",
  ).all()

  // Workspace members (clients with workspace assignment)
  let members = { results: [] }
  if (workspaceId) {
    members = await env.DB.prepare(
      `SELECT u.id, u.email FROM users u
       INNER JOIN user_workspaces uw ON uw.user_id = u.id
       WHERE uw.workspace_id = ? AND u.status = 'active' AND u.email IS NOT NULL`,
    ).bind(workspaceId).all()
  }

  return {
    admins: admins.results.map((u) => ({ email: u.email, userId: u.id })),
    workspaceMembers: members.results.map((u) => ({ email: u.email, userId: u.id })),
  }
}

/**
 * Build a branded HTML email body.
 */
function buildEmailHtml(title, bodyLines) {
  const lines = bodyLines.map((l) => `<p style="margin:4px 0;color:#333;">${l}</p>`).join('')
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="border-bottom:3px solid #00c8d4;padding-bottom:12px;margin-bottom:20px;">
    <h2 style="margin:0;color:#0a0a0a;">WarSignalLabs Portal</h2>
    <span style="font-size:0.75rem;color:#888;">v0.1.0</span>
  </div>
  <h3 style="color:#0a0a0a;margin-bottom:8px;">${title}</h3>
  ${lines}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
  <p style="font-size:0.75rem;color:#999;">This is an automated notification from portal.warsignallabs.net</p>
</body>
</html>`
}

/**
 * Notify on a workspace event. Sends to admins + workspace members.
 * Admins always receive notifications (full visibility).
 * Client actors are excluded from self-notification.
 * Uses ctx.waitUntil() for non-blocking delivery.
 */
function notifyWorkspaceEvent(env, ctx, { eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata }) {
  const task = (async () => {
    try {
      const { admins, workspaceMembers } = await resolveRecipients(env, workspaceId)

      // Build admin email set — admins always receive (never excluded)
      const adminEmails = new Set(admins.map((a) => a.email.toLowerCase()))

      // Deduplicate: admins always included, non-admin actors excluded
      const allRecipients = new Map()
      for (const r of [...admins, ...workspaceMembers]) {
        if (!r.email) continue
        const emailLower = r.email.toLowerCase()
        const isActor = emailLower === (actorEmail || '').toLowerCase()
        const isAdmin = adminEmails.has(emailLower)
        // Admins always get notified; non-admins skip if they're the actor
        if (isAdmin || !isActor) {
          allRecipients.set(emailLower, r)
        }
      }

      if (allRecipients.size === 0) return

      const subject = `[WSL Portal] ${title}`
      const html = buildEmailHtml(title, bodyLines)
      const text = bodyLines.join('\n')

      // Send individual emails for per-recipient logging
      for (const [email, recipient] of allRecipients) {
        await sendEmail(env, {
          to: email,
          subject,
          html,
          text,
          eventType,
          workspaceId,
          recipientUserId: recipient.userId,
          metadata,
        })
      }
    } catch (err) {
      console.error('notifyWorkspaceEvent failed:', err.message)
    }
  })()

  // Non-blocking — Worker responds immediately, email sends in background
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
}

/**
 * Check workspace storage against 75% threshold. Fires alert if exceeded.
 */
function checkStorageThreshold(env, ctx, { workspaceId, workspaceName, workspaceSlug, actorEmail }) {
  const task = (async () => {
    try {
      const ws = await env.DB.prepare(
        'SELECT storage_quota_mb FROM workspaces WHERE id = ?',
      ).bind(workspaceId).first()
      if (!ws || !ws.storage_quota_mb) return

      const usage = await env.DB.prepare(
        'SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM files WHERE workspace_id = ?',
      ).bind(workspaceId).first()

      const usedMb = (usage?.total_bytes || 0) / (1024 * 1024)
      const quotaMb = ws.storage_quota_mb
      const pct = Math.round((usedMb / quotaMb) * 100)

      if (pct >= 75) {
        notifyWorkspaceEvent(env, ctx, {
          eventType: 'workspace.threshold',
          workspaceId,
          workspaceName: workspaceName || workspaceSlug,
          title: `Storage Alert: ${workspaceName || workspaceSlug} at ${pct}%`,
          bodyLines: [
            `<strong>Workspace:</strong> ${workspaceName || workspaceSlug}`,
            `<strong>Storage Used:</strong> ${usedMb.toFixed(1)} MB of ${quotaMb} MB (${pct}%)`,
            `<strong>Status:</strong> ${pct >= 90 ? '🔴 Critical' : '🟡 Warning'} — storage is ${pct >= 90 ? 'nearly full' : 'approaching capacity'}`,
            `Consider archiving old files or increasing the workspace quota.`,
          ],
          actorEmail: null, // admins + members all get threshold alerts
          metadata: { usedMb: usedMb.toFixed(1), quotaMb, pct, workspaceSlug },
        })
      }
    } catch (err) {
      console.error('checkStorageThreshold failed:', err.message)
    }
  })()

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
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

  // Determine current user's effective permission on this workspace
  const userPermission = (user.role === 'admin' || user.role === 'owner')
    ? 'admin'
    : (user.workspacePermissions || {})[params.slug] || 'read'

  return jsonResponse({
    workspace: {
      ...workspace,
      memberCount: memberCount?.count || 0,
      fileCount: fileCount?.count || 0,
      userPermission,
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
async function handleUploadFile(request, env, user, params, ctx) {
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
 * DELETE /api/files/:id — admin only
 */
/**
 * PUT /api/files/:id — replace a file with a new version.
 * Archives the current version to file_versions, uploads the new file to R2,
 * and updates the files record with the new R2 key, size, and version number.
 * Requires write permission on the workspace.
 */
async function handleReplaceFile(request, env, user, params, ctx) {
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
async function handleGetFileVersions(request, env, user, params) {
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

async function handleDeleteFile(request, env, user, params, ctx) {
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
async function handleDownloadFile(request, env, user, params, ctx) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Folder Endpoints (v0.2.0)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate folder name: no slashes, max 100 chars, non-empty.
 */
function validateFolderName(name) {
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
async function handleListFolderContents(request, env, user, params) {
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
async function handleCreateFolder(request, env, user, params, ctx) {
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
    title: `Folder Created: ${folderName}`,
    bodyLines: [
      `<strong>Folder:</strong> ${folderName}`,
      `<strong>Workspace:</strong> ${workspace.name}`,
      `<strong>Created by:</strong> ${user.email || user.userId}`,
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
async function handleRenameFolder(request, env, user, params) {
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
async function handleDeleteFolder(request, env, user, params, ctx) {
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
    folderName: folder.name,
    workspaceSlug: folder.workspace_slug,
    ipAddress: getClientIp(request),
  })

  // Notify
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'folder.delete',
    workspaceId: folder.workspace_id,
    workspaceName: folder.workspace_name,
    title: `Folder Deleted: ${folder.name}`,
    bodyLines: [
      `<strong>Folder:</strong> ${folder.name}`,
      `<strong>Workspace:</strong> ${folder.workspace_name}`,
      `<strong>Deleted by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { folderId: folder.id, folderName: folder.name, workspaceSlug: folder.workspace_slug },
  })

  return jsonResponse({ message: 'Folder deleted' })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Move Endpoints (v0.2.0)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PATCH /api/files/:id/move — move a file to a different folder
 * Body: { folder_id } (null = move to root)
 */
async function handleMoveFile(request, env, user, params, ctx) {
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

/**
 * PATCH /api/folders/:id/move — move a folder to a new parent
 * Body: { parent_folder_id } (null = move to root)
 */
async function handleMoveFolder(request, env, user, params, ctx) {
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
    title: `Folder Moved: ${folder.name}`,
    bodyLines: [
      `<strong>Folder:</strong> ${folder.name}`,
      `<strong>Workspace:</strong> ${folder.workspace_name}`,
      `<strong>Moved by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { folderId: folder.id, folderName: folder.name, fromParentId: folder.parent_folder_id, toParentId: newParentId },
  })

  return jsonResponse({ message: 'Folder moved', folder: { id: folder.id, parent_folder_id: newParentId } })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Admin & User Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

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
 * GET /api/dashboard/projects — admin/owner only
 * Serves the operational dashboard projects list.
 * v0.2.2: file-based (embedded JSON). Future: D1-backed.
 */
async function handleDashboardProjects(request, env, user) {
  requireRole(user, 'admin', 'owner')

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
async function handleCreateUser(request, env, user, ctx) {
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

  // Notify admins of new user creation
  notifyWorkspaceEvent(env, ctx, {
    eventType: 'user.create',
    workspaceId: null,
    workspaceName: null,
    title: `New User Created: ${username}`,
    bodyLines: [
      `<strong>Username:</strong> ${username}`,
      `<strong>Email:</strong> ${email}`,
      `<strong>Role:</strong> ${newRole || 'client'}`,
      `<strong>Created by:</strong> ${user.email || user.userId}`,
    ],
    actorEmail: user.email,
    metadata: { userId, username, email, role: newRole || 'client' },
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
// GW-OS Briefs — Service-to-service ingest + portal read endpoints
// ═══════════════════════════════════════════════════════════════════════════════

function verifyServiceKey(request, env) {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return token.length > 0 && token === env.WSL_SERVICE_KEY
}

function _parseBriefRow(row) {
  const safeParse = (val, fallback) => {
    if (!val) return fallback
    try { return JSON.parse(val) } catch { return fallback }
  }
  return {
    date: row.date,
    status: row.status,
    agent_count: row.agent_count,
    validation_errors: row.validation_errors,
    leads: safeParse(row.leads_json, []),
    actions: safeParse(row.actions_json, []),
    world_news: safeParse(row.world_news_json, []),
    economy: safeParse(row.economy_json, {}),
    threats: safeParse(row.threats_json, []),
    pipeline: safeParse(row.pipeline_json, {}),
    content: safeParse(row.content_json, {}),
    security: safeParse(row.security_json, []),
    raw_brief: row.raw_brief,
    created_at: row.created_at,
  }
}

async function handlePostBrief(request, env) {
  if (!verifyServiceKey(request, env)) {
    return errorResponse('Unauthorized', 401)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return errorResponse('date is required and must be YYYY-MM-DD', 400)
  }
  if (!body.raw_brief || body.raw_brief.length < 10) {
    return errorResponse('raw_brief is required', 400)
  }

  const existing = await env.DB
    .prepare('SELECT date FROM briefs WHERE date = ?')
    .bind(body.date)
    .first()

  await env.DB
    .prepare(`
      INSERT OR REPLACE INTO briefs (
        date, status, agent_count, validation_errors,
        leads_json, actions_json, world_news_json, economy_json,
        threats_json, pipeline_json, content_json, security_json,
        raw_brief, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE(
          (SELECT created_at FROM briefs WHERE date = ?),
          datetime('now')
        ))
    `)
    .bind(
      body.date,
      body.status ?? 'completed',
      body.agent_count ?? 0,
      body.validation_errors ?? 0,
      body.leads_json ?? '[]',
      body.actions_json ?? '[]',
      body.world_news_json ?? '[]',
      body.economy_json ?? '{}',
      body.threats_json ?? '[]',
      body.pipeline_json ?? '{}',
      body.content_json ?? '{}',
      body.security_json ?? '[]',
      body.raw_brief,
      body.date,
    )
    .run()

  await logAudit(env, 'gw-os-service', existing ? 'brief.updated' : 'brief.created', {
    resourceType: 'brief',
    resourceId: body.date,
    agent_count: body.agent_count,
    status: body.status,
  })

  return jsonResponse(
    { date: body.date, action: existing ? 'updated' : 'created' },
    existing ? 200 : 201,
  )
}

async function handleListBriefs(request, env, user) {
  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0'), 0)
  const from = url.searchParams.get('from') ?? null
  const to = url.searchParams.get('to') ?? null

  const conditions = []
  const binds = []
  if (from) { conditions.push('date >= ?'); binds.push(from) }
  if (to)   { conditions.push('date <= ?'); binds.push(to) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [countRow, rows] = await Promise.all([
    env.DB
      .prepare(`SELECT COUNT(*) as total FROM briefs ${where}`)
      .bind(...binds)
      .first(),
    env.DB
      .prepare(
        `SELECT date, status, agent_count, validation_errors, created_at
         FROM briefs ${where}
         ORDER BY date DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all(),
  ])

  return jsonResponse({
    briefs: rows.results,
    pagination: { total: countRow?.total ?? 0, limit, offset },
  })
}

async function handleGetLatestBrief(request, env, user) {
  const row = await env.DB
    .prepare('SELECT * FROM briefs ORDER BY date DESC LIMIT 1')
    .first()

  if (!row) {
    return errorResponse('No briefs found', 404)
  }

  return jsonResponse(_parseBriefRow(row))
}

async function handleGetBrief(request, env, user, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorResponse('Invalid date format — use YYYY-MM-DD', 400)
  }

  const row = await env.DB
    .prepare('SELECT * FROM briefs WHERE date = ?')
    .bind(date)
    .first()

  if (!row) {
    return errorResponse(`Brief not found: ${date}`, 404)
  }

  return jsonResponse(_parseBriefRow(row))
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

        // /api/me — returns the authenticated user's D1 role, workspaces, and permissions
        if (pathname === '/api/me' && method === 'GET') {
          return jsonResponse({
            userId: user.dbUserId || user.userId,
            role: user.role,
            workspaceSlugs: user.workspaceSlugs,
            workspacePermissions: user.workspacePermissions,
            email: user.email,
          })
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
