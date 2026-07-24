// worker/src/auth.js
// JWT verification (RS256 via Web Crypto), Clerk Backend API lookup, and the
// D1-authoritative requireAuth/RBAC middleware.

import { errorResponse } from './cors.js'
import { logAudit } from './audit.js'

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

const clerkUserCache = new Map()
const CLERK_CACHE_TTL_MS = 5 * 60 * 1000

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

export async function requireAuth(request, env) {
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

  const publicMetadata = payload.publicMetadata || payload.metadata?.publicMetadata || {}

  let dbUserId = null
  let role = null
  let workspaceSlugs = null
  let workspacePermissions = null

  const dbUser = await env.DB.prepare(
    'SELECT id, role, username, email, status FROM users WHERE clerk_id = ?',
  )
    .bind(clerkUserId)
    .first()

  if (dbUser) {
    if (dbUser.status === 'inactive') {
      throw errorResponse('Account has been deactivated. Contact your administrator.', 403)
    }
    dbUserId = dbUser.id
    role = dbUser.role
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

  if (!dbUserId) {
    const emailCandidates = [
      payload.email,
      payload.primaryEmail,
    ].filter(Boolean)

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
        role = matched.role
        await env.DB.prepare('UPDATE users SET clerk_id = ? WHERE id = ?')
          .bind(clerkUserId, matched.id).run()
        console.log(`Auto-mapped Clerk ${clerkUserId} → ${matched.id} via email`)

        // Invitation acceptance (Phase 2 spec §3): first sign-in of an invited
        // user activates the account and closes out their pending invitations.
        if (matched.status === 'invited') {
          await env.DB.prepare(`UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?`)
            .bind(matched.id).run()
        }
        const accepted = await env.DB.prepare(
          `UPDATE invitations SET status = 'accepted', accepted_at = datetime('now')
           WHERE LOWER(email) = LOWER(?) AND status = 'pending'`,
        ).bind(email).run()
        if (accepted?.meta?.changes > 0) {
          await logAudit(env, matched.id, 'member.join', {
            resourceType: 'user', resourceId: matched.id,
            invitationsAccepted: accepted.meta.changes,
          })
        }

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
          role = matched.role
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

    if (!dbUserId) {
      throw errorResponse('Account is not provisioned. Contact your administrator.', 403)
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

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw errorResponse(
      `Forbidden: requires one of [${roles.join(', ')}], you have [${user.role}]`,
      403,
    )
  }
}

export function requireWorkspaceAccess(user, workspaceSlug) {
  if (user.role === 'admin') {
    return
  }
  if (!user.workspaceSlugs.includes(workspaceSlug)) {
    throw errorResponse('Forbidden: you do not have access to this workspace', 403)
  }
}

export function hasWorkspaceWriteAccess(user, workspaceSlug) {
  if (user.role === 'admin') return true
  const perm = (user.workspacePermissions || {})[workspaceSlug]
  return perm === 'write' || perm === 'admin'
}

// wsAdmin (§3.5): global admin, or admin permission on this specific workspace.
export function hasWorkspaceAdminPermission(user, workspaceSlug) {
  if (user.role === 'admin') return true
  return (user.workspacePermissions || {})[workspaceSlug] === 'admin'
}

// Ceiling check for member remove/downgrade (§3.1). remainingAdminCount is the
// count of admin-permission members the workspace would have AFTER the action.
// Returns a human-readable violation, or null if the change is allowed.
export function memberChangeViolation(targetRole, remainingAdminCount) {
  if (targetRole === 'admin') {
    return 'Cannot remove or downgrade a global admin'
  }
  if (remainingAdminCount < 1) {
    return 'Workspace must retain at least one admin-permission member'
  }
  return null
}

// Extracts @username tokens from a comment body, keeping only tokens that
// match a member of the workspace the comment belongs to. Silent no-op for
// non-members — never an error, no cross-workspace leakage (Phase 3 spec §2).
export function parseMentions(body, memberUsernames) {
  const memberSet = new Set(memberUsernames)
  // Lookbehind requires whitespace or start-of-string before '@' so an email
  // address like foo@cdepalma.com is never mistaken for a mention.
  const matches = body.match(/(?<=^|\s)@([a-zA-Z0-9_-]+)/g) || []
  const found = []
  const seen = new Set()
  for (const m of matches) {
    const username = m.slice(1)
    if (memberSet.has(username) && !seen.has(username)) {
      seen.add(username)
      found.push(username)
    }
  }
  return found
}

// Whether a notification email should be sent to a recipient with the given
// email_pref, for the given event type (Phase 3 spec §4; Phase 4 spec §4 adds
// task.assign — the master plan's middle tier is "mentions & ASSIGNMENTS only").
// task.status stays 'all'-tier-only: routine activity, not a directed event.
// Never gates the inbox row — only the email leg.
export function shouldEmailForPref(emailPref, eventType) {
  if (emailPref === 'none') return false
  if (emailPref === 'mentions') return eventType === 'comment.mention' || eventType === 'task.assign'
  return true // 'all'
}

// Edit ceiling (Phase 3 spec §2): author only, and only while the comment is
// not (soft-)deleted. Not even wsAdmin may alter someone else's words.
export function isCommentEditableBy(user, comment) {
  if (comment.deleted_at) return false
  return comment.author_id === (user.dbUserId || user.userId)
}

// Delete ceiling (Phase 3 spec §2): author, wsAdmin, or global admin. Always
// soft delete at the call site — this only decides who may do it.
export function commentDeleteViolation(user, comment, workspaceSlug) {
  const isAuthor = comment.author_id === (user.dbUserId || user.userId)
  if (isAuthor || hasWorkspaceAdminPermission(user, workspaceSlug)) {
    return null
  }
  return 'Only the comment author or a workspace admin may delete this comment'
}

// Delete ceilings for projects/tasks (Phase 4 spec §2): creator, wsAdmin, or
// global admin. Same shape as commentDeleteViolation — always soft delete at
// the call site; these only decide who may do it.
export function projectDeleteViolation(user, project, workspaceSlug) {
  const isCreator = project.created_by === (user.dbUserId || user.userId)
  if (isCreator || hasWorkspaceAdminPermission(user, workspaceSlug)) return null
  return 'Only the project creator or a workspace admin may delete this project'
}

export function taskDeleteViolation(user, task, workspaceSlug) {
  const isCreator = task.created_by === (user.dbUserId || user.userId)
  if (isCreator || hasWorkspaceAdminPermission(user, workspaceSlug)) return null
  return 'Only the task creator or a workspace admin may delete this task'
}

// Open-task guard for project deletion (Phase 4 spec §2): a project with
// todo/in_progress tasks blocks (409 at the call site) unless force is set,
// in which case the call site also soft-deletes those tasks.
export function projectDeleteBlocked(openTaskCount, force) {
  if (openTaskCount > 0 && !force) {
    return `Project has ${openTaskCount} open task${openTaskCount === 1 ? '' : 's'} — pass force=1 to delete them too`
  }
  return null
}
