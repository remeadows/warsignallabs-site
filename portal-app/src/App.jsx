import { Routes, Route, Navigate } from 'react-router-dom'
import { SignedIn, SignedOut, RedirectToSignIn } from '@clerk/clerk-react'
import ErrorBoundary from './components/ErrorBoundary'
import PortalLayout from './layouts/PortalLayout'
import Dashboard from './pages/Dashboard'
import WorkspaceDetail from './pages/WorkspaceDetail'
import AdminUsers from './pages/AdminUsers'
import AdminWorkspaces from './pages/AdminWorkspaces'
import AdminAuditLog from './pages/AdminAuditLog'
import Settings from './pages/Settings'
import NotFound from './pages/NotFound'
import Forbidden from './pages/Forbidden'

function ProtectedRoute({ children }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut><RedirectToSignIn /></SignedOut>
    </>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <PortalLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="workspace/:slug" element={<WorkspaceDetail />} />
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/workspaces" element={<AdminWorkspaces />} />
          <Route path="admin/audit-log" element={<AdminAuditLog />} />
          <Route path="settings" element={<Settings />} />
          <Route path="forbidden" element={<Forbidden />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  )
}
