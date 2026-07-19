import { describe, it, expect, vi } from 'vitest'

// Regression test for the un-awaited-handler bug: every route handler is an
// async function, so a Response thrown inside one (requireRole 403s, in-handler
// errorResponse throws) becomes a REJECTED PROMISE. If the router returns that
// promise without `await`, the rejection escapes the router's try/catch and
// surfaces as a Cloudflare 1101 uncaught exception instead of the clean JSON
// error the catch block exists to produce. Discovered live when the first
// owner-role request hit an admin-only endpoint (Phase 2 ceiling tests).
vi.mock('./auth.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({
      userId: 'clerk_test',
      dbUserId: 'usr-test',
      role: 'client',
      workspaceSlugs: [],
      workspacePermissions: {},
    })),
  }
})

import router from './router.js'

describe('router error handling', () => {
  it('returns a clean 403 JSON Response when an async handler throws (not an unhandled rejection)', async () => {
    const request = new Request('https://api.test/api/audit-log', { method: 'GET' })

    // Must NOT reject — the thrown Response must be caught and returned.
    const res = await router.fetch(request, {}, {})

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/Forbidden/)
  })
})
