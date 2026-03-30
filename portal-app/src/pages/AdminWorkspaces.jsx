import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import './Admin.css'

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`
}

const PRESET_COLORS = ['#00c8d4', '#39ff14', '#ffaa00', '#ff6b9d', '#9d4edd', '#4cc9f0', '#f77f00']

export default function AdminWorkspaces() {
  const api = useApiClient()
  const { isPrivileged, role, authLoading } = usePortalAuth()

  const [workspaces, setWorkspaces] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: '', slug: '', color: '#00c8d4' })
  const [createLoading, setCreateLoading] = useState(false)

  // Edit modal
  const [editWs, setEditWs] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', color: '' })
  const [editLoading, setEditLoading] = useState(false)
  const [success, setSuccess] = useState(null)

  const fetchWorkspaces = useCallback(async () => {
    try {
      const data = await api.getAnalytics()
      setWorkspaces(data.workspaces || [])
    } catch (err) {
      setError(err.data?.error || 'Failed to load workspaces')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (isPrivileged) fetchWorkspaces()
  }, [isPrivileged]) // eslint-disable-line react-hooks/exhaustive-deps

  if (authLoading) {
    return <div className="loading-state"><span className="spinner" /> Loading…</div>
  }

  if (!isPrivileged) {
    return <Navigate to="/forbidden" replace />
  }

  const autoSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const showMessage = (msg) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(null), 3000)
  }

  const handleDelete = async (ws) => {
    if (!confirm(`Delete workspace "${ws.name}"? This will delete all files and assignments. This cannot be undone.`)) return
    try {
      await api.deleteWorkspace(ws.slug)
      showMessage(`Workspace "${ws.name}" deleted`)
      await fetchWorkspaces()
    } catch (err) {
      setError(err.data?.error || 'Failed to delete workspace')
    }
  }

  const handleCreate = async () => {
    if (!createForm.name || !createForm.slug) {
      setError('Name and slug are required')
      return
    }
    setCreateLoading(true)
    try {
      await api.createWorkspace(createForm)
      setShowCreate(false)
      showMessage(`Workspace "${createForm.name}" created`)
      setCreateForm({ name: '', slug: '', color: '#00c8d4' })
      await fetchWorkspaces()
    } catch (err) {
      setError(err.data?.error || 'Failed to create workspace')
    } finally {
      setCreateLoading(false)
    }
  }

  const openEdit = (ws) => {
    setEditWs(ws)
    setEditForm({ name: ws.name, color: ws.color })
  }

  const handleEdit = async () => {
    setEditLoading(true)
    try {
      await api.updateWorkspace(editWs.slug, editForm)
      setEditWs(null)
      showMessage(`Workspace updated`)
      await fetchWorkspaces()
    } catch (err) {
      setError(err.data?.error || 'Failed to update workspace')
    } finally {
      setEditLoading(false)
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
            <h1>Workspace Management</h1>
            <div className="admin-page__subtitle">{workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''}</div>
          </div>
          {role === 'admin' && (
            <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
              Create Workspace
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
              <th>Name</th>
              <th>Slug</th>
              <th>Members</th>
              <th>Files</th>
              <th>Storage</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map(ws => (
              <tr key={ws.id}>
                <td><span style={{ color: ws.color, fontWeight: 600 }}>{ws.name}</span></td>
                <td className="mono">{ws.slug}</td>
                <td>{ws.member_count}</td>
                <td>{ws.file_count}</td>
                <td className="mono">{formatBytes(ws.total_bytes)}</td>
                <td className="admin-actions">
                  {role === 'admin' && (
                    <>
                      <button className="btn btn--secondary btn--sm" onClick={() => openEdit(ws)}>
                        Edit
                      </button>
                      <button className="btn btn--danger btn--sm" onClick={() => handleDelete(ws)}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Workspace Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Create Workspace</h2>
              <button className="modal__close" onClick={() => setShowCreate(false)}>&times;</button>
            </div>
            <div className="modal__body">
              <div className="form-field">
                <label className="label">Name</label>
                <input
                  className="form-input"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({
                    ...createForm,
                    name: e.target.value,
                    slug: autoSlug(e.target.value),
                  })}
                  placeholder="Acme Corp"
                />
              </div>
              <div className="form-field">
                <label className="label">Slug</label>
                <input
                  className="form-input mono"
                  value={createForm.slug}
                  onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })}
                  placeholder="acme-corp"
                />
              </div>
              <div className="form-field">
                <label className="label">Color</label>
                <div className="color-picker">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      className={`color-swatch ${createForm.color === c ? 'color-swatch--active' : ''}`}
                      style={{ background: c }}
                      onClick={() => setCreateForm({ ...createForm, color: c })}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal__footer">
              <button className="btn btn--secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleCreate} disabled={createLoading}>
                {createLoading ? 'Creating...' : 'Create Workspace'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Workspace Modal */}
      {editWs && (
        <div className="modal-overlay" onClick={() => setEditWs(null)}>
          <div className="modal card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2>Edit: <span style={{ color: editWs.color }}>{editWs.name}</span></h2>
              <button className="modal__close" onClick={() => setEditWs(null)}>&times;</button>
            </div>
            <div className="modal__body">
              <div className="form-field">
                <label className="label">Name</label>
                <input
                  className="form-input"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
              </div>
              <div className="form-field">
                <label className="label">Color</label>
                <div className="color-picker">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      className={`color-swatch ${editForm.color === c ? 'color-swatch--active' : ''}`}
                      style={{ background: c }}
                      onClick={() => setEditForm({ ...editForm, color: c })}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal__footer">
              <button className="btn btn--secondary" onClick={() => setEditWs(null)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleEdit} disabled={editLoading}>
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
