import { useState, useEffect, useCallback } from 'react'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'

const PERMISSIONS = ['read', 'write', 'admin']

export default function MembersTab({ slug }) {
  const api = useApiClient()
  const { d1User, isAdmin } = usePortalAuth()
  const wsAdmin = isAdmin || d1User?.workspacePermissions?.[slug] === 'admin'

  const [members, setMembers] = useState([])
  const [invitations, setInvitations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePermission, setInvitePermission] = useState('read')
  const [inviting, setInviting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const m = await api.listMembers(slug)
      setMembers(m.members)
      if (wsAdmin) {
        const inv = await api.listInvitations(slug)
        setInvitations(inv.invitations)
      }
      setError(null)
    } catch (err) {
      setError(err.data?.error || 'Could not load members.')
    } finally {
      setLoading(false)
    }
  }, [api, slug, wsAdmin])

  useEffect(() => { load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

  const changePermission = async (userId, permission) => {
    try {
      await api.updateMemberPermission(slug, userId, permission)
      load()
    } catch (err) {
      setError(err.data?.error || 'Permission change failed.')
    }
  }

  const removeMember = async (member) => {
    if (!confirm(`Remove ${member.username} from this workspace?`)) return
    try {
      await api.removeMember(slug, member.id)
      load()
    } catch (err) {
      setError(err.data?.error || 'Remove failed.')
    }
  }

  const invite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    try {
      await api.createInvitation(slug, inviteEmail.trim(), invitePermission)
      setInviteEmail('')
      setInvitePermission('read')
      setError(null)
      load()
    } catch (err) {
      setError(err.data?.error || 'Invite failed.')
    } finally {
      setInviting(false)
    }
  }

  const revoke = async (inv) => {
    try {
      await api.revokeInvitation(inv.id)
      load()
    } catch (err) {
      setError(err.data?.error || 'Revoke failed.')
    }
  }

  if (loading) return <div className="workspace__loading">Loading members…</div>

  return (
    <div className="members-tab">
      {error && (
        <div className="workspace__alert workspace__alert--error">
          {error}
          <button className="workspace__alert-dismiss" onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      <table className="members-table">
        <thead>
          <tr><th>Member</th><th>Email</th><th>Permission</th>{wsAdmin && <th></th>}</tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr key={m.id}>
              <td>
                {m.username}
                {m.role === 'admin' && <span className="members-chip members-chip--admin">Admin</span>}
                {m.role === 'owner' && <span className="members-chip">Collaborator</span>}
                {m.status === 'invited' && <span className="members-chip members-chip--pending">Invited</span>}
              </td>
              <td className="mono">{m.email}</td>
              <td>
                {wsAdmin && m.role !== 'admin' ? (
                  <select value={m.permission} onChange={(e) => changePermission(m.id, e.target.value)}>
                    {PERMISSIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <span>{m.permission}</span>
                )}
              </td>
              {wsAdmin && (
                <td>
                  {m.role !== 'admin' && (
                    <button className="btn btn--danger-outline" onClick={() => removeMember(m)}>Remove</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {wsAdmin && (
        <>
          <h3 className="label">Invite by email</h3>
          <div className="members-invite">
            <input
              type="email"
              placeholder="name@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <select value={invitePermission} onChange={(e) => setInvitePermission(e.target.value)}>
              {PERMISSIONS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button className="btn btn--primary" onClick={invite} disabled={inviting}>
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </div>

          {invitations.length > 0 && (
            <>
              <h3 className="label">Pending invitations</h3>
              <table className="members-table">
                <tbody>
                  {invitations.map(inv => (
                    <tr key={inv.id}>
                      <td className="mono">{inv.email}</td>
                      <td>{inv.permission}</td>
                      <td><button className="btn btn--danger-outline" onClick={() => revoke(inv)}>Revoke</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}
