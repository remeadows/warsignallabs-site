import { describe, it, expect } from 'vitest'
import { requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission, memberChangeViolation, parseMentions, shouldEmailForPref, isCommentEditableBy, commentDeleteViolation, projectDeleteViolation, taskDeleteViolation, projectDeleteBlocked } from './auth.js'

function makeUser(overrides = {}) {
  return {
    userId: 'clerk_123',
    dbUserId: 'usr-999',
    role: 'client',
    workspaceSlugs: [],
    workspacePermissions: {},
    email: 'test@example.com',
    ...overrides,
  }
}

describe('requireRole', () => {
  it('allows a user whose role is in the allowed list', () => {
    const user = makeUser({ role: 'admin' })
    expect(() => requireRole(user, 'admin', 'owner')).not.toThrow()
  })

  it('throws a 403 Response for a user whose role is not in the allowed list', async () => {
    const user = makeUser({ role: 'client' })
    let thrown
    try {
      requireRole(user, 'admin', 'owner')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
    const body = await thrown.json()
    expect(body.error).toContain('Forbidden')
  })
})

describe('requireWorkspaceAccess', () => {
  it('allows admin regardless of workspaceSlugs', () => {
    const user = makeUser({ role: 'admin', workspaceSlugs: [] })
    expect(() => requireWorkspaceAccess(user, 'any-workspace')).not.toThrow()
  })

  it('allows a client whose workspaceSlugs includes the target', () => {
    const user = makeUser({ role: 'client', workspaceSlugs: ['blueprint-advisory'] })
    expect(() => requireWorkspaceAccess(user, 'blueprint-advisory')).not.toThrow()
  })

  it('throws a 403 Response for a client without access to the workspace', async () => {
    const user = makeUser({ role: 'client', workspaceSlugs: ['warsignallabs'] })
    let thrown
    try {
      requireWorkspaceAccess(user, 'blueprint-advisory')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
  })
})

describe('hasWorkspaceWriteAccess', () => {
  it('returns true for admin regardless of workspacePermissions', () => {
    const user = makeUser({ role: 'admin', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'any-workspace')).toBe(true)
  })

  it('returns true for a client with write permission on the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { 'blueprint-advisory': 'write' } })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(true)
  })

  it('returns false for a client with only read permission on the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { 'blueprint-advisory': 'read' } })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(false)
  })

  it('returns false for a client with no permission entry for the workspace', () => {
    const user = makeUser({ role: 'client', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'blueprint-advisory')).toBe(false)
  })
})

describe('owner is NOT a global bypass (Phase 2 §3.1)', () => {
  it('requireWorkspaceAccess throws 403 for an owner with no membership', () => {
    const user = makeUser({ role: 'owner', workspaceSlugs: ['their-own'] })
    let thrown
    try { requireWorkspaceAccess(user, 'russ-workspace') } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(Response)
    expect(thrown.status).toBe(403)
  })

  it('requireWorkspaceAccess allows an owner whose workspaceSlugs includes the target', () => {
    const user = makeUser({ role: 'owner', workspaceSlugs: ['their-own'] })
    expect(() => requireWorkspaceAccess(user, 'their-own')).not.toThrow()
  })

  it('hasWorkspaceWriteAccess is false for an owner with no permission entry', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: {} })
    expect(hasWorkspaceWriteAccess(user, 'russ-workspace')).toBe(false)
  })

  it('hasWorkspaceWriteAccess is true for an owner with write permission', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'write' } })
    expect(hasWorkspaceWriteAccess(user, 'their-own')).toBe(true)
  })

  it('admin still bypasses both', () => {
    const user = makeUser({ role: 'admin', workspaceSlugs: [], workspacePermissions: {} })
    expect(() => requireWorkspaceAccess(user, 'anything')).not.toThrow()
    expect(hasWorkspaceWriteAccess(user, 'anything')).toBe(true)
  })
})

describe('hasWorkspaceAdminPermission', () => {
  it('true for global admin regardless of permissions', () => {
    expect(hasWorkspaceAdminPermission(makeUser({ role: 'admin' }), 'any')).toBe(true)
  })
  it('true for owner with admin permission on the workspace', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'admin' } })
    expect(hasWorkspaceAdminPermission(user, 'their-own')).toBe(true)
  })
  it('false for owner with only write permission', () => {
    const user = makeUser({ role: 'owner', workspacePermissions: { 'their-own': 'write' } })
    expect(hasWorkspaceAdminPermission(user, 'their-own')).toBe(false)
  })
  it('false for owner with no entry', () => {
    expect(hasWorkspaceAdminPermission(makeUser({ role: 'owner' }), 'other')).toBe(false)
  })
  it('true for client with admin permission (permission tier, not global role, decides)', () => {
    const user = makeUser({ role: 'client', workspacePermissions: { ws: 'admin' } })
    expect(hasWorkspaceAdminPermission(user, 'ws')).toBe(true)
  })
})

describe('memberChangeViolation (remove/downgrade ceilings)', () => {
  it('blocks any change targeting a global admin', () => {
    expect(memberChangeViolation('admin', 5)).toMatch(/global admin/i)
  })
  it('blocks a change that would leave zero admin-permission members', () => {
    expect(memberChangeViolation('client', 0)).toMatch(/at least one/i)
  })
  it('allows a normal change', () => {
    expect(memberChangeViolation('client', 1)).toBeNull()
    expect(memberChangeViolation('owner', 2)).toBeNull()
  })
})

describe('parseMentions', () => {
  const members = ['rmeadows', 'cdepalma', 'armeadows']

  it('extracts a single mention matching a member', () => {
    expect(parseMentions('hey @cdepalma check this', members)).toEqual(['cdepalma'])
  })
  it('ignores a mention of a non-member', () => {
    expect(parseMentions('hey @randomguy check this', members)).toEqual([])
  })
  it('extracts multiple distinct mentions, deduplicated', () => {
    expect(parseMentions('@rmeadows and @cdepalma, also @rmeadows again', members)).toEqual(['rmeadows', 'cdepalma'])
  })
  it('does not match a mention embedded mid-word', () => {
    expect(parseMentions('email me at foo@cdepalma.com', members)).toEqual([])
  })
  it('returns empty for no mentions', () => {
    expect(parseMentions('just a plain comment', members)).toEqual([])
  })
})

describe('shouldEmailForPref', () => {
  it('all: every event type emails', () => {
    expect(shouldEmailForPref('all', 'comment.create')).toBe(true)
    expect(shouldEmailForPref('all', 'comment.mention')).toBe(true)
    expect(shouldEmailForPref('all', 'file.upload')).toBe(true)
  })
  it('none: nothing emails', () => {
    expect(shouldEmailForPref('none', 'comment.mention')).toBe(false)
    expect(shouldEmailForPref('none', 'file.upload')).toBe(false)
  })
  it('mentions: only comment.mention emails', () => {
    expect(shouldEmailForPref('mentions', 'comment.mention')).toBe(true)
    expect(shouldEmailForPref('mentions', 'comment.create')).toBe(false)
    expect(shouldEmailForPref('mentions', 'file.upload')).toBe(false)
  })
  it('mentions tier includes task.assign but not task.status (spec §4, "mentions & assignments only")', () => {
    expect(shouldEmailForPref('mentions', 'task.assign')).toBe(true)
    expect(shouldEmailForPref('mentions', 'task.status')).toBe(false)
  })
  it('all/none tiers treat task events like any other', () => {
    expect(shouldEmailForPref('all', 'task.assign')).toBe(true)
    expect(shouldEmailForPref('all', 'task.status')).toBe(true)
    expect(shouldEmailForPref('none', 'task.assign')).toBe(false)
  })
})

describe('isCommentEditableBy', () => {
  it('true for the author on a non-deleted comment', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-1', deleted_at: null })).toBe(true)
  })
  it('false for a non-author', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-2', deleted_at: null })).toBe(false)
  })
  it('false for the author once the comment is deleted', () => {
    const user = makeUser({ dbUserId: 'usr-1' })
    expect(isCommentEditableBy(user, { author_id: 'usr-1', deleted_at: '2026-07-21 10:00:00' })).toBe(false)
  })
})

describe('commentDeleteViolation', () => {
  it('allows the author', () => {
    const user = makeUser({ dbUserId: 'usr-1', role: 'client' })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('allows a wsAdmin deleting someone else\'s comment', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'client', workspacePermissions: { ws: 'admin' } })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('allows a global admin regardless of permission entry', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'admin', workspacePermissions: {} })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toBeNull()
  })
  it('blocks a non-author, non-wsAdmin', () => {
    const user = makeUser({ dbUserId: 'usr-2', role: 'client', workspacePermissions: {} })
    expect(commentDeleteViolation(user, { author_id: 'usr-1' }, 'ws')).toMatch(/author|admin/i)
  })
})

describe('projectDeleteViolation', () => {
  const project = { created_by: 'usr-999' }

  it('allows the creator', () => {
    expect(projectDeleteViolation(makeUser(), project, 'acme')).toBeNull()
  })
  it('allows wsAdmin who is not the creator', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'admin' } })
    expect(projectDeleteViolation(u, project, 'acme')).toBeNull()
  })
  it('allows a global admin', () => {
    const u = makeUser({ dbUserId: 'usr-002', role: 'admin' })
    expect(projectDeleteViolation(u, project, 'acme')).toBeNull()
  })
  it('blocks a write-permission non-creator', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'write' } })
    expect(projectDeleteViolation(u, project, 'acme')).toMatch(/creator or a workspace admin/)
  })
})

describe('taskDeleteViolation', () => {
  const task = { created_by: 'usr-999' }

  it('allows the creator', () => {
    expect(taskDeleteViolation(makeUser(), task, 'acme')).toBeNull()
  })
  it('blocks a non-creator without admin permission', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'write' } })
    expect(taskDeleteViolation(u, task, 'acme')).toMatch(/creator or a workspace admin/)
  })
  it('allows wsAdmin', () => {
    const u = makeUser({ dbUserId: 'usr-002', workspacePermissions: { acme: 'admin' } })
    expect(taskDeleteViolation(u, task, 'acme')).toBeNull()
  })
})

describe('projectDeleteBlocked', () => {
  it('blocks when open tasks exist and force is not set', () => {
    expect(projectDeleteBlocked(3, false)).toMatch(/3 open task/)
  })
  it('allows when open tasks exist but force is set', () => {
    expect(projectDeleteBlocked(3, true)).toBeNull()
  })
  it('allows when no open tasks', () => {
    expect(projectDeleteBlocked(0, false)).toBeNull()
  })
  it('singularizes the message for one task', () => {
    expect(projectDeleteBlocked(1, false)).toMatch(/1 open task —/)
  })
})
