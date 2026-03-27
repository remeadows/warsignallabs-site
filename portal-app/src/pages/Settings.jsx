import { UserProfile } from '@clerk/clerk-react'

export default function Settings() {
  return (
    <div className="settings-page fade-in">
      <div style={{ marginBottom: '1.5rem' }}>
        <span className="label">// Settings</span>
        <h1 style={{ marginTop: '0.3rem' }}>Account Settings</h1>
      </div>

      <UserProfile
        appearance={{
          elements: {
            rootBox: { width: '100%' },
            card: {
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'none',
            },
          },
        }}
      />
    </div>
  )
}
