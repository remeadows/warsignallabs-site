import { useState } from 'react'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'
import { PRESET_COLORS } from '../../constants/palette'

export default function WorkspaceSettingsTab({ slug, workspace, onSaved }) {
  const api = useApiClient()
  const { d1User } = usePortalAuth()
  const [name, setName] = useState(workspace.name)
  const [color, setColor] = useState(workspace.color)
  const [emailPref, setEmailPref] = useState(d1User?.emailPref || 'all')
  const [saving, setSaving] = useState(false)
  const [prefSaving, setPrefSaving] = useState(false)
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

  const savePref = async (pref) => {
    const previous = emailPref
    setEmailPref(pref)
    setPrefSaving(true)
    try {
      await api.updatePreferences(pref)
    } catch {
      setEmailPref(previous)
      setMessage({ kind: 'err', text: 'Could not save email preference.' })
    } finally {
      setPrefSaving(false)
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

      <label className="label" style={{ marginTop: '1.5rem' }}>Email notifications (applies to your account, all workspaces)</label>
      <div className="settings-tab__radios">
        {[
          { value: 'all', label: 'All activity' },
          { value: 'mentions', label: 'Mentions only' },
          { value: 'none', label: 'None' },
        ].map((opt) => (
          <label key={opt.value} className="settings-tab__radio">
            <input
              type="radio"
              name="email_pref"
              checked={emailPref === opt.value}
              onChange={() => savePref(opt.value)}
              disabled={prefSaving}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  )
}
