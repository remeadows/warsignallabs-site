import { useState } from 'react'
import { useApiClient } from '../api/client'
import { PRESET_COLORS } from '../constants/palette'

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export default function NewWorkspaceModal({ onClose, onCreated }) {
  const api = useApiClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError(null)
    const base = slugify(name)
    // Auto-slug with numeric suffix on collision (spec §5).
    for (let n = 1; n <= 10; n++) {
      const slug = n === 1 ? base : `${base}-${n}`
      try {
        const result = await api.createWorkspace({ name: name.trim(), slug, color })
        onCreated(result.workspace)
        return
      } catch (err) {
        if (err.status === 409) continue
        setError(err.status === 403 ? 'Permission denied.' : (err.data?.error || 'Could not create workspace.'))
        setSaving(false)
        return
      }
    }
    setError('Could not find an available name — try a different one.')
    setSaving(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2>New Workspace</h2>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal__body">
          {error && (
            <div className="workspace__alert workspace__alert--error">
              {error}
            </div>
          )}
          <div className="form-field">
            <label className="label">Name</label>
            <input
              className="form-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              autoFocus
            />
            {name.trim() && <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>/{slugify(name)}</div>}
          </div>
          <div className="form-field">
            <label className="label">Color</label>
            <div className="color-picker">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  className={`color-swatch ${color === c ? 'color-swatch--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="modal__footer">
          <button className="btn btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn--primary" onClick={handleCreate} disabled={saving}>
            {saving ? 'Creating…' : 'Create Workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
