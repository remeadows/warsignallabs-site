import { Outlet, NavLink, Navigate, useLocation } from 'react-router-dom'
import { usePortalAuth } from '../contexts/PortalAuth'
import './DashboardLayout.css'

export default function DashboardLayout() {
  const { isPrivileged, authLoading } = usePortalAuth()
  const location = useLocation()

  if (authLoading) {
    return (
      <div className="ops-dashboard fade-in">
        <div className="ops-dashboard__loading">
          <div className="spinner" />
        </div>
      </div>
    )
  }

  if (!isPrivileged) {
    return <Navigate to="/forbidden" state={{ from: location }} replace />
  }

  return (
    <div className="ops-dashboard fade-in">
      <div className="ops-dashboard__header">
        <span className="label">// Operations Dashboard</span>
      </div>

      <div className="ops-dashboard__body">
        <nav className="ops-sidebar">
          <NavLink
            to="/dashboard/projects"
            className={({ isActive }) =>
              `ops-sidebar__link ${isActive ? 'ops-sidebar__link--active' : ''}`
            }
          >
            Projects
          </NavLink>
          <span className="ops-sidebar__link ops-sidebar__link--future">
            Business Docs
          </span>
          <span className="ops-sidebar__link ops-sidebar__link--future">
            GW-OS Briefs
          </span>
        </nav>

        <div className="ops-content">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
