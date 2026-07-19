// worker/src/routes/members.js
// Workspace membership + invitations (Phase 2). All ceilings enforced here
// server-side via the pure helpers in ../auth.js — UI hiding is not enforcement.
import { jsonResponse, errorResponse } from '../cors.js'
import { requireWorkspaceAccess, hasWorkspaceAdminPermission, memberChangeViolation } from '../auth.js'
import { logAudit, getClientIp } from '../audit.js'
import { sendEmail, buildEmailHtml, escapeHtml } from '../notify.js'

export async function getWorkspaceBySlug(env, slug) {
  return env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE slug = ?')
    .bind(slug).first()
}

async function adminPermissionCount(env, workspaceId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM user_workspaces WHERE workspace_id = ? AND permission = 'admin'`,
  ).bind(workspaceId).first()
  return row?.cnt || 0
}

/** GET /api/workspaces/:slug/members — any member */
export async function handleListMembers(request, env, user, params) {
  requireWorkspaceAccess(user, params.slug)
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const result = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.role, u.status, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE uw.workspace_id = ? ORDER BY u.username`,
  ).bind(workspace.id).all()

  return jsonResponse({ members: result.results })
}

/** PATCH /api/workspaces/:slug/members/:userId — wsAdmin. Body: {permission} */
export async function handleUpdateMemberPermission(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const { permission } = body
  if (!['read', 'write', 'admin'].includes(permission)) {
    return errorResponse("permission must be one of: read, write, admin", 400)
  }

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)
  if (target.permission === permission) {
    return jsonResponse({ message: 'No change', permission })
  }

  // Ceiling: never a global admin; never zero out the last admin-permission member.
  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' && permission !== 'admin'
    ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.permission_change.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, attempted: permission, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('UPDATE user_workspaces SET permission = ? WHERE id = ?')
    .bind(permission, target.uw_id).run()

  await logAudit(env, user.userId, 'member.permission_change', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, from: target.permission, to: permission,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Permission updated', permission })
}

/** DELETE /api/workspaces/:slug/members/:userId — wsAdmin */
export async function handleRemoveMember(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const target = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, uw.id AS uw_id, uw.permission
     FROM users u INNER JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE u.id = ? AND uw.workspace_id = ?`,
  ).bind(params.userId, workspace.id).first()
  if (!target) return errorResponse('Member not found in this workspace', 404)

  const currentAdmins = await adminPermissionCount(env, workspace.id)
  const remaining = target.permission === 'admin' ? currentAdmins - 1 : currentAdmins
  const violation = memberChangeViolation(target.role, remaining)
  if (violation) {
    await logAudit(env, user.userId, 'member.remove.denied', {
      resourceType: 'member', resourceId: target.id,
      workspaceSlug: params.slug, reason: violation,
      ipAddress: getClientIp(request),
    })
    throw errorResponse(`Forbidden: ${violation}`, 403)
  }

  await env.DB.prepare('DELETE FROM user_workspaces WHERE id = ?').bind(target.uw_id).run()

  await logAudit(env, user.userId, 'member.remove', {
    resourceType: 'member', resourceId: target.id,
    workspaceSlug: params.slug, username: target.username,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Member removed' })
}

/** POST /api/workspaces/:slug/invitations — wsAdmin. Body: {email, permission} */
export async function handleCreateInvitation(request, env, user, params, ctx) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  let body
  try { body = await request.json() } catch { return errorResponse('Invalid JSON', 400) }
  const email = (body.email || '').trim().toLowerCase()
  const { permission } = body
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse('A valid email is required', 400)
  }
  if (!['read', 'write', 'admin'].includes(permission)) {
    return errorResponse("permission must be one of: read, write, admin", 400)
  }

  // Edge rules (spec §4): already a member -> 409; already pending -> 409.
  let invitee = await env.DB.prepare('SELECT id, username, status, clerk_id FROM users WHERE LOWER(email) = ?')
    .bind(email).first()
  if (invitee) {
    const existingMembership = await env.DB.prepare(
      'SELECT id FROM user_workspaces WHERE user_id = ? AND workspace_id = ?',
    ).bind(invitee.id, workspace.id).first()
    if (existingMembership) {
      return errorResponse('Already a member — change their permission from the members list instead', 409)
    }
  }
  const pendingInvite = await env.DB.prepare(
    `SELECT id FROM invitations WHERE email = ? AND workspace_id = ? AND status = 'pending'`,
  ).bind(email, workspace.id).first()
  if (pendingInvite) {
    return errorResponse('Invitation already pending — revoke it first to re-send', 409)
  }

  // Create the user row if none exists (status='invited'; activated by
  // requireAuth's email auto-map on first sign-in — no Clerk API dependency).
  const statements = []
  if (!invitee) {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'invited'
    let username = base
    for (let n = 2; ; n++) {
      const clash = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()
      if (!clash) break
      username = `${base}-${n}`
    }
    const newUserId = `usr-${crypto.randomUUID().slice(0, 8)}`
    statements.push(env.DB.prepare(
      `INSERT INTO users (id, username, email, role, status, created_at, updated_at)
       VALUES (?, ?, ?, 'client', 'invited', datetime('now'), datetime('now'))`,
    ).bind(newUserId, username, email))
    invitee = { id: newUserId, username, status: 'invited', clerk_id: null }
  }

  // An invitee who has already signed in before (clerk_id already mapped)
  // gets access immediately — there's no future "first sign-in" acceptance
  // step to wait for, so record the invitation as accepted right away. A
  // pending invite for an already-active member could otherwise be revoked
  // later as if it were never accepted, stripping access that was in fact
  // already granted.
  const alreadyProvisioned = !!invitee.clerk_id
  const invStatus = alreadyProvisioned ? 'accepted' : 'pending'

  // Membership row now; it goes live the moment their sign-in maps (or
  // immediately, if they're already provisioned).
  statements.push(env.DB.prepare(
    `INSERT INTO user_workspaces (id, user_id, workspace_id, permission, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).bind(crypto.randomUUID(), invitee.id, workspace.id, permission))

  const invId = `inv-${crypto.randomUUID().slice(0, 8)}`
  statements.push(env.DB.prepare(
    alreadyProvisioned
      ? `INSERT INTO invitations (id, workspace_id, email, permission, invited_by, status, created_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', datetime('now'), datetime('now'))`
      : `INSERT INTO invitations (id, workspace_id, email, permission, invited_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).bind(invId, workspace.id, email, permission, user.dbUserId))

  // All-or-nothing: a new user row, its membership, and its invitation must
  // never partially land — a membership row with no invitation record is
  // orphaned (handleRevokeInvitation can never find it to clean up).
  await env.DB.batch(statements)

  await logAudit(env, user.userId, 'member.invite', {
    resourceType: 'invitation', resourceId: invId,
    workspaceSlug: params.slug, email, permission,
    ipAddress: getClientIp(request),
  })

  const html = buildEmailHtml(`You've been invited to ${escapeHtml(workspace.name)}`, [
    `<strong>Workspace:</strong> ${escapeHtml(workspace.name)}`,
    `<strong>Access level:</strong> ${escapeHtml(permission)}`,
    `<strong>Invited by:</strong> ${escapeHtml(user.email || 'the workspace admin')}`,
    `Sign in with this email address at <a href="https://portal.warsignallabs.net">portal.warsignallabs.net</a> — your access is ready.`,
  ])
  ctx.waitUntil(sendEmail(env, {
    to: email,
    subject: `WarSignalLabs Portal — invitation to ${workspace.name}`,
    html,
    text: `You've been invited to ${workspace.name} (${permission}). Sign in with this email at https://portal.warsignallabs.net`,
    eventType: 'member.invite',
    workspaceId: workspace.id,
    recipientUserId: invitee.id,
    metadata: { invitationId: invId, permission },
  }))

  return jsonResponse({ invitation: { id: invId, email, permission, status: invStatus } }, 201)
}

/** GET /api/workspaces/:slug/invitations — wsAdmin */
export async function handleListInvitations(request, env, user, params) {
  if (!hasWorkspaceAdminPermission(user, params.slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  const workspace = await getWorkspaceBySlug(env, params.slug)
  if (!workspace) return errorResponse('Workspace not found', 404)

  const result = await env.DB.prepare(
    `SELECT id, email, permission, status, created_at FROM invitations
     WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC`,
  ).bind(workspace.id).all()

  return jsonResponse({ invitations: result.results })
}

/** DELETE /api/invitations/:id — wsAdmin on the invitation's workspace. Revoke + undo. */
export async function handleRevokeInvitation(request, env, user, params) {
  const invitation = await env.DB.prepare(
    `SELECT i.id, i.email, i.status, i.workspace_id, w.slug AS workspace_slug
     FROM invitations i INNER JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.id = ?`,
  ).bind(params.id).first()
  if (!invitation) return errorResponse('Invitation not found', 404)

  if (!hasWorkspaceAdminPermission(user, invitation.workspace_slug)) {
    throw errorResponse('Forbidden: workspace admin permission required', 403)
  }
  if (invitation.status !== 'pending') {
    return errorResponse(`Cannot revoke an invitation that is ${invitation.status}`, 409)
  }

  await env.DB.prepare(`UPDATE invitations SET status = 'revoked' WHERE id = ?`)
    .bind(invitation.id).run()

  // Undo the pre-created membership. Safe: inviting an existing member is
  // 409-blocked, so a membership row matching a pending invite can only have
  // come from that invite.
  const invitee = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = ?')
    .bind(invitation.email).first()
  if (invitee) {
    await env.DB.prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace_id = ?')
      .bind(invitee.id, invitation.workspace_id).run()
  }

  await logAudit(env, user.userId, 'invitation.revoke', {
    resourceType: 'invitation', resourceId: invitation.id,
    workspaceSlug: invitation.workspace_slug, email: invitation.email,
    ipAddress: getClientIp(request),
  })

  return jsonResponse({ message: 'Invitation revoked' })
}
