import { useState, useEffect } from 'react'
import { useApiClient } from '../api/client'

function StatusBadge({ status }) {
  const map = {
    delivered: 'badge--success',
    pending: 'badge--warning',
    failed: 'badge--error',
  }
  return <span className={`badge ${map[status] || ''}`}>{status}</span>
}

function BriefDetail({ brief, onBack }) {
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <button className="btn btn--secondary" onClick={onBack} style={{ fontSize: '0.8rem' }}>
          &larr; Back
        </button>
        <h2 className="mono">{brief.date}</h2>
        <StatusBadge status={brief.status} />
        <span className="label" style={{ marginLeft: 'auto' }}>
          {brief.agent_count} agents
        </span>
      </div>

      {brief.validation_errors > 0 && (
        <div className="card" style={{ marginBottom: '1rem', borderLeft: '3px solid var(--error)', padding: '0.75rem 1rem' }}>
          <span style={{ color: 'var(--error)', fontWeight: 500 }}>
            {brief.validation_errors} validation error{brief.validation_errors !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <SectionCard title="Leads" items={brief.leads} />
        <SectionCard title="Security" items={brief.security} />
        <SectionCard title="Threats" items={brief.threats} />
        <SectionCard title="Actions" items={brief.actions} />
        <SectionCard title="World News" items={brief.world_news} />
        {brief.economy && Object.keys(brief.economy).length > 0 && (
          <ObjectCard title="Economy" data={brief.economy} />
        )}
        {brief.pipeline && Object.keys(brief.pipeline).length > 0 && (
          <ObjectCard title="Pipeline" data={brief.pipeline} />
        )}
        {brief.content && Object.keys(brief.content).length > 0 && (
          <ObjectCard title="Content" data={brief.content} />
        )}
      </div>

      {brief.raw_brief && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
            onClick={() => setShowRaw(!showRaw)}
          >
            <span className="label">Raw Brief</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {showRaw ? 'collapse' : 'expand'}
            </span>
          </div>
          {showRaw && (
            <pre style={{
              marginTop: '0.75rem',
              padding: '1rem',
              background: 'var(--bg-primary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.78rem',
              lineHeight: 1.5,
              overflow: 'auto',
              maxHeight: '500px',
              whiteSpace: 'pre-wrap',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
            }}>
              {brief.raw_brief}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function SectionCard({ title, items }) {
  if (!items || items.length === 0) return null

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--accent)' }}>
        {title}
      </h3>
      <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {items.map((item, i) => (
          <li key={i} style={{ fontSize: '0.82rem', lineHeight: 1.4, color: 'var(--text-secondary)' }}>
            {typeof item === 'string' ? item : JSON.stringify(item)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ObjectCard({ title, data }) {
  return (
    <div className="card" style={{ padding: '1rem' }}>
      <h3 style={{ fontSize: '0.85rem', marginBottom: '0.75rem', color: 'var(--accent)' }}>
        {title}
      </h3>
      <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {Object.entries(data).map(([key, value]) => (
          <div key={key} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.82rem' }}>
            <dt className="mono" style={{ color: 'var(--text-muted)', minWidth: '120px', flexShrink: 0 }}>
              {key}
            </dt>
            <dd style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {typeof value === 'string' ? value : JSON.stringify(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function DashboardBriefs() {
  const api = useApiClient()
  const [briefs, setBriefs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedBrief, setSelectedBrief] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    api.listBriefs()
      .then(data => setBriefs(data.briefs || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelectBrief(date) {
    setDetailLoading(true)
    setError(null)
    api.getBrief(date)
      .then(brief => setSelectedBrief(brief))
      .catch(err => setError(err.message))
      .finally(() => setDetailLoading(false))
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

  if (error && !selectedBrief && briefs.length === 0) {
    return <div className="card" style={{ color: 'var(--error)' }}>Failed to load briefs: {error}</div>
  }

  if (detailLoading) {
    return (
      <div className="stagger-in">
        <div className="skeleton skeleton--heading" />
        <div className="skeleton skeleton--card" style={{ marginTop: '1rem', height: '200px' }} />
      </div>
    )
  }

  if (selectedBrief) {
    return <BriefDetail brief={selectedBrief} onBack={() => setSelectedBrief(null)} />
  }

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h2>GW-OS Briefs</h2>
        <span className="label" style={{ marginLeft: 'auto' }}>{briefs.length} brief{briefs.length !== 1 ? 's' : ''}</span>
      </div>

      {error && (
        <div className="card" style={{ color: 'var(--error)', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {briefs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
          No briefs found.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Agents</th>
                <th>Errors</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {briefs.map(b => (
                <tr
                  key={b.date}
                  onClick={() => handleSelectBrief(b.date)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono" style={{ fontWeight: 500 }}>{b.date}</td>
                  <td><StatusBadge status={b.status} /></td>
                  <td style={{ color: 'var(--text-secondary)' }}>{b.agent_count ?? '—'}</td>
                  <td>
                    {b.validation_errors > 0
                      ? <span style={{ color: 'var(--error)' }}>{b.validation_errors}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>0</span>
                    }
                  </td>
                  <td className="mono" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {b.created_at ? new Date(b.created_at).toLocaleString() : '—'}
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
