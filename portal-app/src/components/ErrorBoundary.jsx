import { Component } from 'react'
import { Link } from 'react-router-dom'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-page fade-in" style={{ textAlign: 'center', paddingTop: '4rem' }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '3rem',
            color: 'var(--warning)',
            fontWeight: 700,
          }}>
            ERR
          </div>
          <h2 style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            Something went wrong
          </h2>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem', fontSize: '0.85rem', maxWidth: '400px', margin: '0.5rem auto 0' }}>
            An unexpected error occurred. Try refreshing the page.
          </p>
          {this.state.error && (
            <pre style={{
              color: 'var(--text-muted)',
              fontSize: '0.7rem',
              fontFamily: 'var(--font-mono)',
              marginTop: '1rem',
              padding: '0.6rem',
              background: 'var(--bg-surface)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              maxWidth: '500px',
              margin: '1rem auto',
              overflow: 'auto',
              textAlign: 'left',
            }}>
              {this.state.error.message}
            </pre>
          )}
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.6rem', justifyContent: 'center' }}>
            <button
              className="btn btn--primary"
              onClick={() => window.location.reload()}
            >
              Refresh Page
            </button>
            <Link to="/dashboard" className="btn btn--secondary" onClick={() => this.setState({ hasError: false, error: null })}>
              Back to Dashboard
            </Link>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
