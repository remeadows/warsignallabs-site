import { useState, useEffect } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import CommentThread from './CommentThread'

const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }

export default function TaskDrawer({ workspaceSlug, task, canWrite, onClose, onChanged }) {
  const api = useApiClient()
  const { isAdmin, d1User } = usePortalAuth()
  const [members, setMembers] = useState([])
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description || '')
  const [status, setStatus] = useState(task.status)
  const [assigneeId, setAssigneeId] = useState(task.assignee_id || '')
  const [dueDate, setDueDate] = useState(task.due_date || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const canDelete = isAdmin
    || d1User?.workspacePermissions?.[workspaceSlug] === 'admin'
    || task.created_by === d1User?.userId

  // Task identity change (drawer reused for another task without remount).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(task.title)
    setDescription(task.description || '')
    setStatus(task.status)
    setAssigneeId(task.assignee_id || '')
    setDueDate(task.due_date || '')
    setError(null)
  }, [task.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    api.listMembers(workspaceSlug)
      .then((data) => { if (!cancelled) setMembers(data.members || []) })
      .catch(() => { /* select degrades to current assignee only */ })
    return () => { cancelled = true }
  }, [api, workspaceSlug])

  // Escape closes the drawer — dialog semantics (a11y).
  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const save = async () => {
    if (!title.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api.updateTask(task.id, {
        title: title.trim(),
        description: description.trim() || null,
        status,
        assignee_id: assigneeId || null,
        due_date: dueDate || null,
      })
      await onChanged()
      onClose()
    } catch (err) {
      setError(err.data?.error || 'Could not save task.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete task "${task.title}"?`)) return
    try {
      await api.deleteTask(task.id)
      await onChanged()
      onClose()
    } catch (err) {
      setError(err.data?.error || 'Could not delete task.')
    }
  }

  return (
    <div className="slide-over-overlay" onClick={onClose}>
      <div className="slide-over" role="dialog" aria-modal="true" aria-label={`Task: ${task.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="slide-over__header">
          <h3>{task.title}</h3>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>

        {error && <div className="workspace__alert workspace__alert--error">{error}</div>}

        {canWrite ? (
          <div className="task-drawer__fields">
            <label className="label">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label className="label">Description</label>
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            <label className="label">Status</label>
            <select className="ops-filter-select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="label">Assignee</label>
            <select className="ops-filter-select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.username}</option>)}
            </select>
            <label className="label">Due date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <div className="task-drawer__actions">
              {canDelete && <button className="btn btn--danger btn--sm" onClick={remove}>Delete</button>}
              <button className="btn btn--primary" onClick={save} disabled={saving || !title.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="task-drawer__fields task-drawer__fields--readonly">
            {task.description && <p className="task-drawer__description">{task.description}</p>}
            <div className="task-drawer__row mono">
              <span className="badge">{STATUS_LABELS[task.status]}</span>
              {task.assignee_username && <span>{task.assignee_username}</span>}
              {task.due_date && <span>due {task.due_date}</span>}
            </div>
          </div>
        )}

        <div className="task-drawer__comments">
          <span className="label">Comments</span>
          <CommentThread workspaceSlug={workspaceSlug} entityType="task" entityId={task.id} />
        </div>
      </div>
    </div>
  )
}
