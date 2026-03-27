import { useState, useEffect, useCallback } from 'react'
import { useUser } from '@clerk/clerk-react'
import { Navigate } from 'react-router-dom'
import { useApiClient } from '../api/client'
import './Admin.css'

const roleBadge = {
  admin: 'badge badge--error',
  owner: 'badge',
  client: 'badge badge--warning',
}

const ROLES = ['admin', 'owner', 'client']

export default function AdminUsers() {
  const { user } = useUser()
  const api = useApiClient()
  const role = user?.publicMetadata?.role || 'client'
  const isPrivileged = role === 'admin' || role === 'owner'
  const isAdmin = role === 'admin'

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [actionLoading, setActionLoading] = useState(null)

  // Create user modal
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ username: '', email: '', role: 'client' })
  const [createLoading, setCreateLoading] = useState(false)

  // Workspace assignment modal
  const [assignModalUser, setAssignModalUser] = useState(null)
  const [allWorkspaces, setAllWorkspaces] = useState([])
  const [userAssignments, setUserAssignments] = useState([])
  const [assignLoading, setAssignLoading] = useState(false)

  const fetchUsers = useCallback(async () => {
    try {
      const data = await api.listUsers()
      setUsers(data.users || [])
    } catch (err) {
      setError(err.data?.error || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (isPrivileged) fetchUsers()
  }, [isPrivileged]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!isPrivileged) {
    return <Navigate to="/forbidden" replace />
  }

  const showMessage = (msg) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(null), 3000)
  }

  const handleToggleStatus = async (u) => {
    const action = u.status === 'active' ? 'deactivate' : 'activate'
    if (!confirm(`${action === 'deactivate' ? 'Deactivate' : 'Activate'} user "${u.username}"?`)) return

    setActionLoading(u.id)
    try {
      if (action === 'deactivate') {
        await api.deactivateUser(u.id)
      } else {
        await api.activateUser(u.id)
      }
      showMessage(`User ${u.username} ${action}d`)
      await fetchUsers()
    } catch (err) {
      setError(err.data?.error || `Failed to ${action} user`)
    } finally {
      setActionLoading(null)
    }
  }

  const handleRoleChange = async (u, newRole) => {
    if (newRole === u.role) return
    if (!confirm(`Change ${u.username}'s role from "${u.role}" to "${newRole}"?`)) return

    setActionLoading(u.id)
    try {
      await api.changeRole(u.id, newRole)
      showMessage(`${u.username} role changed to ${newRole}`)
      await fetchUsers()
    } catch (err) {
      setError(err.data?.error || 'Failed to change role')
    } finally {
      setActionLoading(null)
    }
  }

  const handleCreateUser = async () => {
    if (!createForm.username || !createForm.email) {
      setError('Username and email are required')
      return
    }
    setCreateLoading(true)
    try {
      await api.createUser(createForm)
      setShowCreate(false)
      setCreateForm({ username: '', email: '', role: 'client' })
      showMessage(`User ${createForm.username} created`)
      await fetchUsers()
    } catch (err) {
      setError(err.data?.error || 'Failed to create user')
    } finally {
      setCreateLoading(false)
    }
  }

  const openAssignModal = async (u) => {
    setAssignModalUser(u)
    setAssignLoading(true)
    try {
      const [wsData, assignData] = await Promise.all([
        api.listWorkspaces(),
        api.getUserWorkspaces(u.id),
      ])
      setAllWorkspaces(wsData.workspaces || [])
      setUserAssignments((assignData.workspaces || []).map(w => ({
        workspace_id: w.id,
        permission: w.permission || 'read',
      })))
    } catch (err) {
      setError(err.data?.error || 'Failed to load workspace assignments')
      setAssignModalUser(null)
    } finally {
      setAssignLoading(false)
    }
  }

  const toggleWorkspace = (wsId) => {
    setUserAssignments(prev => {
      const exists = prev.find(a => a.workspace_id === wsId)
      if (exists) return prev.filter(a => a.workspace_id !== wsId)
      return [...prev, { workspace_id: wsId, permission: 'read' }]
    })
  }

  const setPermission = (wsId, permission) => {
    setUserAssignments(prev =>
      prev.map(a => a.workspace_id === wsId ? { ...a, permission } : a)
    )
  }

  const saveAssignments = async () => {
    setAssignLoading(true)
    try {
      await api.updateUserWorkspaces(assignModalUser.id, userAssignments)
      setAssignModalUser(null)
      showMessage(`Workspace access updated for ${assignModalUser.username}`)
      await fetchUsers()
    } catch (err) {
      setError(err.data?.error || 'Failed to update workspace assignments')
    } finally {
      setAssignLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="admin-page fade-in">
        <div className="admin-page__loading"><div className="spinner" /></div>
      </div>
    )
  }

  return (
    <div className="admin-page fade-in">
      <div className="admin-page__header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <span className="label">// Admin</span>
            <h1>User Management</h1>
            <div className="admin-page__subtitle">{users.length} user{users.length !== 1 ? 's' : ''} registered</div>
          </div>
          {isAdmin && (
            <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
              Add User
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="admin-page__error">
          {error}
          <button className="workspace__alert-dismiss" onClick={() => setError(null)}>&times;</button>
        </div>
      )}
      {success && <div className="toast toast--success">{success}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Workspaces</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td className="mono">{u.username || '—'}</td>
                <td>{u.email || '—'}</td>
                <td>
                  {isAdmin ? (
                    <select
                      className="role-select"
                      value={u.role}
                      onChange={(e) => handleRoleChange(u, e.target.value)}
                      disabled={actionLoading === u.id}
                    >
                      {ROLES.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={roleBadge[u.role] || 'badge'}>{u.role}</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${u.status === 'active' ? 'badge--success' : 'badge--error'}`}>
                    {u.status || 'active'}
                  </span>
                </td>
                <td>{u.workspace_count}</td>
                <td className="admin-actions">
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => openAssignModal(u)}
                  >
                    Assign
                  </button>
                  <button
                    className={`btn btn--sm ${u.status === 'active' ? 'btn--danger' : 'btn--primary'}`}
                    onClick={() => handleToggleStatus(u)}
                    disabled={actionLoading === u.id}
                  >
                    {actionLoading === u.id ? '...' : u.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Add User</h2>
              <button className="modal__close" onClick={() => setShowCreate(false)}>&times;</button>
            </div>
            <div className="modal__body">
              <div className="form-field">
                <label className="label">Username</label>
                <input
                  className="form-input mono"
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  placeholder="jsmith"
                />
              </div>
              <div className="form-field">
                <label className="label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>
              <div className="form-field">
                <label className="label">Role</label>
                <select
                  className="form-input"
                  value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                >
                  {ROLES.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                Note: The user will also need a Clerk account to sign in. Create their Clerk account separately and set matching publicMetadata.
              </p>
            </div>
            <div className="modal__footer">
              <button className="btn btn--secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleCreateUser} disabled={createLoading}>
                {createLoading ? 'Creating...' : 'Add User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Workspace Assignment Modal */}
      {assignModalUser && (
        <div className="modal-overlay" onClick={() => setAssignModalUser(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Workspace Access: <span style={{ color: 'var(--accent)' }}>{assignModalUser.username}</span></h2>
              <button className="modal__close" onClick={() => setAssignModalUser(null)}>&times;</button>
            </div>

            {assignLoading ? (
              <div className="modal__loading"><div className="spinner" /></div>
            ) : (
              <div className="modal__body">
                {allWorkspaces.map(ws => {
                  const assigned = userAssignments.find(a => a.workspace_id === ws.id)
                  return (
                    <div key={ws.id} className={`assign-row ${assigned ? 'assign-row--active' : ''}`}>
                      <label className="assign-row__check">
                        <input
                          type="checkbox"
                          checked={!!assigned}
                          onChange={() => toggleWorkspace(ws.id)}
                        />
                        <span style={{ color: ws.color, fontWeight: 600 }}>{ws.name}</span>
                      </label>
                      {assigned && (
                        <select
                          className="assign-row__perm"
                          value={assigned.permission}
                          onChange={(e) => setPermission(ws.id, e.target.value)}
                        >
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                          <option value="admin">Admin</option>
                        </select>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div className="modal__footer">
              <button className="btn btn--secondary" onClick={() => setAssignModalUser(null)}>Cancel</button>
              <button className="btn btn--primary" onClick={saveAssignments} disabled={assignLoading}>
                {assignLoading ? 'Saving...' : 'Save Assignments'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
