import { describe, it, expect } from 'vitest'
import { requireRole, requireWorkspaceAccess, hasWorkspaceWriteAccess } from './auth.js'

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
