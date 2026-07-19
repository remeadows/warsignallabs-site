import { useState } from 'react'
import { useApiClient } from '../../api/client'
import { PRESET_COLORS } from '../../constants/palette'

export default function WorkspaceSettingsTab({ slug, workspace, onSaved }) {
  const api = useApiClient()
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  const save = async () => {
    setSaving(true)
    try {
      await api.updateWorkspace(slug, { name, color })
      setMessage({ kind: 'ok', text: 'Saved.' })
      onSaved()
    } catch (err) {
      setMessage({ kind: 'err', text: err.data?.error || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-tab">
      {message && (
        <div className={`workspace__alert ${message.kind === 'err' ? 'workspace__alert--error' : ''}`}>
          {message.text}
        </div>
      )}
      <label className="label">Workspace name</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="label">Color</label>
      <div className="modal__swatches">
        {PRESET_COLORS.map(c => (
          <button
            key={c}
            className={`color-swatch ${color === c ? 'color-swatch--active' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <button className="btn btn--primary" onClick={save} disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  )
}
