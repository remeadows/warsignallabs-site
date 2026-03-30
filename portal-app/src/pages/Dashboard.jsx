import { useUser } from '@clerk/clerk-react'
import { Link } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import './Dashboard.css'

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`
}

function formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function actionLabel(action) {
  const map = {
    'file.upload': 'uploaded a file',
    'file.download': 'downloaded a file',
    'file.delete': 'deleted a file',
    'workspace.view': 'viewed a workspace',
  }
  return map[action] || action
}

export default function Dashboard() {
  const { user } = useUser()
  const api = useApiClient()
  const { isAdmin } = usePortalAuth()

  const [workspaces, setWorkspaces] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)

  const firstName = user?.firstName || user?.username || 'there'

  useEffect(() => {
    async function load() {
      try {
        const [wsData, analyticsData] = await Promise.all([
          api.listWorkspaces(),
          isAdmin ? api.getAnalytics() : Promise.resolve(null),
        ])
        setWorkspaces(wsData.workspaces || [])
        if (analyticsData) setAnalytics(analyticsData)
      } catch (err) {
        console.error('Dashboard load error:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Map workspace stats from analytics (if admin)
  const wsStats = {}
  if (analytics?.workspaces) {
    for (const ws of analytics.workspaces) {
      wsStats[ws.slug] = ws
    }
  }

  if (loading) {
    return (
      <div className="dashboard fade-in">
        <div className="dashboard__header">
          <span className="label">// Dashboard</span>
          <div className="skeleton skeleton--heading" />
        </div>
        <div className="dashboard__grid stagger-in">
          <div className="card skeleton skeleton--card" />
          <div className="card skeleton skeleton--card" />
          <div className="card skeleton skeleton--card" />
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard fade-in">
      <div className="dashboard__header">
        <span className="label">// Dashboard</span>
        <h1>Welcome back, {firstName}</h1>
      </div>

      <div className="dashboard__grid stagger-in">
        {workspaces.map(ws => {
          const stats = wsStats[ws.slug]
          return (
            <Link key={ws.slug} to={`/workspace/${ws.slug}`} className="workspace-card card" style={{ borderLeftColor: ws.color }}>
              <div className="workspace-card__name" style={{ color: ws.color }}>{ws.name}</div>
              <div className="workspace-card__meta">
                {stats ? `${stats.file_count} files · ${formatBytes(stats.total_bytes)}` : '—'}
              </div>
            </Link>
          )
        })}
      </div>

      {isAdmin && analytics && (
        <div className="dashboard__stats">
          <span className="label">System</span>
          <div className="stats-row">
            <div className="stat card">
              <div className="stat__value">{analytics.overview.totalWorkspaces}</div>
              <div className="stat__label">Workspaces</div>
            </div>
            <div className="stat card">
              <div className="stat__value">{analytics.overview.totalUsers}</div>
              <div className="stat__label">Users</div>
            </div>
            <div className="stat card">
              <div className="stat__value">{formatBytes(analytics.overview.totalStorageBytes)}</div>
              <div className="stat__label">Storage Used</div>
            </div>
            <div className="stat card">
              <div className="stat__value">{analytics.overview.totalFiles}</div>
              <div className="stat__label">Files</div>
            </div>
          </div>
        </div>
      )}

      <div className="dashboard__activity">
        <span className="label">Recent Activity</span>
        <div className="activity-list">
          {analytics?.recentActivity && analytics.recentActivity.length > 0 ? (
            analytics.recentActivity.map((entry, i) => (
              <div key={i} className="activity-item">
                <span className="activity-item__user mono">{entry.user_name || 'system'}</span>
                <span className="activity-item__action">{actionLabel(entry.action)}</span>
                <span className="activity-item__time mono">{formatTime(entry.created_at)}</span>
              </div>
            ))
          ) : (
            <div className="activity-empty">
              No activity yet. Upload a file to get started.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
