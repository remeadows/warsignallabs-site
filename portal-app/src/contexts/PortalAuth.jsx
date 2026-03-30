/**
 * D1-authoritative auth context.
 * PortalLayout fetches /api/me once, stores the result here.
 * All child pages consume via usePortalAuth() — no duplicate API calls.
 *
 * IMPORTANT: Clerk publicMetadata is NOT used for authorization.
 * D1 is the single source of truth for role and workspace permissions.
 */

import { createContext, useContext } from 'react'

const PortalAuthContext = createContext({
  d1User: null,
  role: 'client',
  isAdmin: false,
  isOwner: false,
  isPrivileged: false,
  authLoading: true,
  workspaces: [],
})

export function PortalAuthProvider({ value, children }) {
  return (
    <PortalAuthContext.Provider value={value}>
      {children}
    </PortalAuthContext.Provider>
  )
}

export function usePortalAuth() {
  return useContext(PortalAuthContext)
}
