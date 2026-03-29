import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { UserButton, useUser } from '@clerk/clerk-react'
import { useState, useEffect } from 'react'
import { useApiClient } from '../api/client'
import './PortalLayout.css'

const PORTAL_NAME = import.meta.env.VITE_PORTAL_NAME || 'WARSIGNALLABS PORTAL'

export default function PortalLayout() {
  const { user } = useUser()
  const location = useLocation()
  const api = useApiClient()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // D1-authoritative user data (fetched from /api/me)
  const [d1User, setD1User] = useState(null)
  // Workspace catalog driven by API (no hardcoded list)
  const [workspaces, setWorkspaces] = useState([])

  useEffect(() => {
    let cancelled = false
    // Fetch D1 user profile and workspace catalog in parallel
    Promise.all([
      api.getMe(),
      api.listWorkspaces(),
    ]).then(([meData, wsData]) => {
      if (cancelled) return
      setD1User(meData)
      setWorkspaces(wsData.workspaces || [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // D1 is authoritative — no Clerk publicMetadata fallback
  const role = d1User?.role || 'client'
  const isAdmin = role === 'admin'
  const isOwner = role === 'owner'

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname])

  return (
    <div className="portal-layout">
      {/* Top Nav */}
      <header className="topnav">
        <div className="topnav__brand">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            {sidebarOpen ? '[ CLOSE ]' : '[ MENU ]'}
          </button>
          <div className="topnav__logo" />
          <span className="topnav__name">{PORTAL_NAME}</span>
          <span className="topnav__version mono">v0.1.0</span>
        </div>
        <div className="topnav__user">
          <span className="topnav__username mono">{user?.username || user?.firstName || 'User'}</span>
          <UserButton afterSignOutUrl="/login" />
        </div>
      </header>

      <div className="portal-body">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <nav className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''}`}>
          <div className="sidebar__section">
            <span className="sidebar__label label">Navigation</span>
            <NavLink to="/dashboard" className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}>
              Dashboard
            </NavLink>
          </div>

          <div className="sidebar__section">
            <span className="sidebar__label label">Workspaces</span>
            {workspaces.map(ws => (
              <NavLink
                key={ws.slug}
                to={`/workspace/${ws.slug}`}
                className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
              >
                <span className="sidebar__dot" style={{ background: ws.color || 'var(--accent)' }} />
                {ws.name}
              </NavLink>
            ))}
          </div>

          {(isAdmin || isOwner) && (
            <div className="sidebar__section">
              <span className="sidebar__label label">Admin</span>
              <NavLink to="/admin/users" className={({ isActive }) => `sidebar__link sidebar__link--admin ${isActive ? 'sidebar__link--active' : ''}`}>
                Users
              </NavLink>
              <NavLink to="/admin/workspaces" className={({ isActive }) => `sidebar__link sidebar__link--admin ${isActive ? 'sidebar__link--active' : ''}`}>
                Workspaces
              </NavLink>
              <NavLink to="/admin/audit-log" className={({ isActive }) => `sidebar__link sidebar__link--admin ${isActive ? 'sidebar__link--active' : ''}`}>
                Audit Log
              </NavLink>
            </div>
          )}

          <div className="sidebar__section sidebar__section--bottom">
            <NavLink to="/settings" className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}>
              Settings
            </NavLink>
          </div>
        </nav>

        {/* Main Content */}
        <main className="main-content fade-in">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
