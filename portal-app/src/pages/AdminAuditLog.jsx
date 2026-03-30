import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import './Admin.css'

const ACTION_TYPES = [
  { value: '', label: 'All Actions' },
  { value: 'file.upload', label: 'File Upload' },
  { value: 'file.download', label: 'File Download' },
  { value: 'file.delete', label: 'File Delete' },
  { value: 'workspace.view', label: 'Workspace View' },
]

function formatTime(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function actionBadgeClass(action) {
  if (action?.includes('upload')) return 'badge badge--success'
  if (action?.includes('delete')) return 'badge badge--error'
  if (action?.includes('download')) return 'badge'
  return 'badge badge--warning'
}

export default function AdminAuditLog() {
  const api = useApiClient()
  const { isPrivileged, authLoading } = usePortalAuth()

  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionFilter, setActionFilter] = useState('')

  const fetchLog = useCallback(async () => {
    if (!isPrivileged) return
    try {
      setLoading(true)
      const params = {}
      if (actionFilter) params.action = actionFilter
      const data = await api.getAuditLog(params)
      setEntries(data.entries || [])
    } catch (err) {
      console.error('AuditLog API error:', err)
      setError(err.data?.error || `Failed to load audit log (${err.status || 'network error'})`)
    } finally {
      setLoading(false)
    }
  }, [api, actionFilter, isPrivileged])

  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  if (authLoading) {
    return <div className="loading-state"><span className="spinner" /> Loading…</div>
  }

  if (!isPrivileged) {
    return <Navigate to="/forbidden" replace />
  }

  return (
    <div className="admin-page fade-in">
      <div className="admin-page__header">
        <span className="label">// Admin</span>
        <h1>Audit Log</h1>
      </div>

      <div className="audit-filters">
        <select
          className="audit-filter-select"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          {ACTION_TYPES.map(a => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
        <button className="btn btn--secondary btn--sm" onClick={fetchLog}>Refresh</button>
      </div>

      {error && <div className="admin-page__error">{error}</div>}

      {loading ? (
        <div className="admin-page__loading"><div className="spinner" /></div>
      ) : entries.length === 0 ? (
        <div className="audit-empty card">
          No audit events {actionFilter ? `matching "${actionFilter}"` : 'recorded yet'}.
        </div>
      ) : (
        <div className="audit-timeline">
          {entries.map(entry => (
            <div key={entry.id} className="audit-entry">
              <div className="audit-entry__header">
                <span className={actionBadgeClass(entry.action)}>{entry.action}</span>
                <span className="audit-entry__user mono">{entry.user_name || entry.user_id}</span>
                <span className="audit-entry__time mono">{formatTime(entry.created_at)}</span>
              </div>
              {entry.details && (
                <div className="audit-entry__details">
                  {entry.details.filename && <span>File: {entry.details.filename}</span>}
                  {entry.details.workspaceSlug && <span>Workspace: {entry.details.workspaceSlug}</span>}
                  {entry.details.sizeBytes && <span>Size: {(entry.details.sizeBytes / 1024).toFixed(1)} KB</span>}
                </div>
              )}
              {entry.ip_address && entry.ip_address !== 'unknown' && (
                <div className="audit-entry__ip mono">{entry.ip_address}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
