// worker/src/auth.js
// JWT verification (RS256 via Web Crypto), Clerk Backend API lookup, and the
// D1-authoritative requireAuth/RBAC middleware.

import { errorResponse } from './cors.js'

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

export function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) {
    throw errorResponse(
      `Forbidden: requires one of [${roles.join(', ')}], you have [${user.role}]`,
      403,
    )
  }
}

export function requireWorkspaceAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') {
    return
  }
  if (!user.workspaceSlugs.includes(workspaceSlug)) {
    throw errorResponse('Forbidden: you do not have access to this workspace', 403)
  }
}

export function hasWorkspaceWriteAccess(user, workspaceSlug) {
  if (user.role === 'admin' || user.role === 'owner') return true
  const perm = (user.workspacePermissions || {})[workspaceSlug]
  return perm === 'write' || perm === 'admin'
}
