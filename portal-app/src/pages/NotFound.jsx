import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="error-page fade-in" style={{ textAlign: 'center', paddingTop: '4rem' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '3rem', color: 'var(--accent)', fontWeight: 700 }}>404</div>
      <h2 style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Page not found</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.85rem' }}>
        The resource you're looking for doesn't exist or has been moved.
      </p>
      <Link to="/dashboard" className="btn btn--primary" style={{ marginTop: '1.5rem', display: 'inline-flex' }}>
        Back to Dashboard
      </Link>
    </div>
  )
}
