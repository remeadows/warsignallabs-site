import { describe, it, expect } from 'vitest'
import { requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess, hasWorkspaceAdminPermission, memberChangeViolation } from './auth.js'

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
