import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApiClient } from '../api/client'

const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' }
const PRIORITY_CLASSES = { 1: 'error', 2: 'warning', 3: '', 4: '' }

function PriorityBadge({ value }) {
  const cls = PRIORITY_CLASSES[value] || ''
  return (
    <span className={`badge ${cls ? `badge--${cls}` : ''}`}>
      {PRIORITY_LABELS[value] || 'None'}
    </span>
  )
}

function StatusBadge({ status }) {
  const map = {
    'In Progress': 'badge--success',
    'Completed': 'badge',
    'Backlog': '',
    'Planned': 'badge--warning',
  }
  return <span className={`badge ${map[status] || ''}`}>{status}</span>
}

export default function DashboardProjects() {
  const api = useApiClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Read filters from URL query params
  const filterStatus = searchParams.get('status') || ''
  const filterPriority = searchParams.get('priority') || ''
  const filterCategory = searchParams.get('category') || ''
  const sortField = searchParams.get('sort') || 'priority'
  const sortDir = searchParams.get('order') || 'asc'

  function updateParam(key, value) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (value) {
        next.set(key, value)
      } else {
        next.delete(key)
      }
      return next
    })
  }

  useEffect(() => {
    api.getDashboardProjects()
      .then(data => setProjects(data.projects || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const statuses = useMemo(() =>
    [...new Set(projects.map(p => p.status))].sort(),
    [projects]
  )

  const categories = useMemo(() =>
    [...new Set(projects.map(p => p.category))].sort(),
    [projects]
  )

  const filtered = useMemo(() => {
    let list = [...projects]
    if (filterStatus) list = list.filter(p => p.status === filterStatus)
    if (filterPriority) list = list.filter(p => String(p.priority) === filterPriority)
    if (filterCategory) list = list.filter(p => p.category === filterCategory)

    list.sort((a, b) => {
      let aVal = a[sortField]
      let bVal = b[sortField]
      if (sortField === 'priority') {
        aVal = aVal || 99
        bVal = bVal || 99
      }
      if (sortField === 'targetDate') {
        aVal = aVal || '9999-12-31'
        bVal = bVal || '9999-12-31'
      }
      if (typeof aVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal
    })
    return list
  }, [projects, filterStatus, filterPriority, filterCategory, sortField, sortDir])

  function toggleSort(field) {
    if (sortField === field) {
      updateParam('order', sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('sort', field)
        next.set('order', 'asc')
        return next
      })
    }
  }

  function sortIndicator(field) {
    if (sortField !== field) return ''
    return sortDir === 'asc' ? ' \u25b2' : ' \u25bc'
  }

  if (loading) {
    return (
      <div className="stagger-in">
        <div className="skeleton skeleton--heading" />
        <div className="skeleton skeleton--card" style={{ marginTop: '1rem' }} />
        <div className="skeleton skeleton--card" style={{ marginTop: '0.5rem' }} />
        <div className="skeleton skeleton--card" style={{ marginTop: '0.5rem' }} />
      </div>
    )
  }

  if (error) {
    return <div className="card" style={{ color: 'var(--error)' }}>Failed to load projects: {error}</div>
  }

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <h2>Projects</h2>
        <span className="label" style={{ marginLeft: 'auto' }}>{filtered.length} of {projects.length}</span>
      </div>

      <div className="ops-filter-bar">
        <select
          value={filterStatus}
          onChange={e => updateParam('status', e.target.value)}
          className="ops-filter-select"
        >
          <option value="">All Statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filterPriority}
          onChange={e => updateParam('priority', e.target.value)}
          className="ops-filter-select"
        >
          <option value="">All Priorities</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Medium</option>
          <option value="4">Low</option>
        </select>
        <select
          value={filterCategory}
          onChange={e => updateParam('category', e.target.value)}
          className="ops-filter-select"
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
          No projects found.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th onClick={() => toggleSort('title')} style={{ cursor: 'pointer' }}>
                  Project{sortIndicator('title')}
                </th>
                <th onClick={() => toggleSort('category')} style={{ cursor: 'pointer' }}>
                  Category{sortIndicator('category')}
                </th>
                <th onClick={() => toggleSort('priority')} style={{ cursor: 'pointer' }}>
                  Priority{sortIndicator('priority')}
                </th>
                <th onClick={() => toggleSort('status')} style={{ cursor: 'pointer' }}>
                  Status{sortIndicator('status')}
                </th>
                <th onClick={() => toggleSort('targetDate')} style={{ cursor: 'pointer' }}>
                  Target{sortIndicator('targetDate')}
                </th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 500 }}>{p.title}</td>
                  <td>
                    <span className="label" style={{ fontSize: '0.7rem' }}>{p.category}</span>
                  </td>
                  <td><PriorityBadge value={p.priority} /></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="mono" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {p.targetDate || '—'}
                  </td>
                  <td>
                    {p.linearUrl && (
                      <a href={p.linearUrl} target="_blank" rel="noopener noreferrer" style={{ marginRight: '0.5rem', fontSize: '0.8rem' }}>
                        Linear
                      </a>
                    )}
                    {p.repoUrl && (
                      <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8rem' }}>
                        Repo
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
