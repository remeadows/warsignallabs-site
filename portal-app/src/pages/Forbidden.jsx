import { Link } from 'react-router-dom'

export default function Forbidden() {
  return (
    <div className="error-page fade-in" style={{ textAlign: 'center', paddingTop: '4rem' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '3rem', color: 'var(--error)', fontWeight: 700 }}>403</div>
      <h2 style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Access denied</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.85rem' }}>
        You don't have permission to access this resource.
      </p>
      <Link to="/dashboard" className="btn btn--secondary" style={{ marginTop: '1.5rem', display: 'inline-flex' }}>
        Back to Dashboard
      </Link>
    </div>
  )
}
