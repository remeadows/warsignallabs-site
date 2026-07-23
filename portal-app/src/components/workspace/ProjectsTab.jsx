import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApiClient } from '../../api/client'
import { usePortalAuth } from '../../contexts/PortalAuth'
import TaskDrawer from '../TaskDrawer'

const STATUS_LABELS = { todo: 'Todo', in_progress: 'In progress', done: 'Done' }
const PROJECT_STATUS_LABELS = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' }
const BOARD_COLUMNS = ['todo', 'in_progress', 'done']

function formatDue(dateStr) {
  if (!dateStr) return null
  const d = new Date(`${dateStr}T00:00:00`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function ProjectsTab({ slug }) {
  const api = useApiClient()
  const { isAdmin, d1User } = usePortalAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const canWrite = isAdmin || ['write', 'admin'].includes(d1User?.workspacePermissions?.[slug])

  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)      // project object or null (list view)
  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [view, setView] = useState('board')           // 'board' | 'list' — component state only
  const [drawerTask, setDrawerTask] = useState(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')

  const loadProjects = useCallback(async () => {
    const data = await api.listProjects(slug)
    return data.projects
  }, [api, slug])

  const loadTasks = useCallback(async (projectId) => {
    const data = await api.listTasks(projectId)
    return data.tasks
  }, [api])

  const openProject = async (project, focusTaskId = null) => {
    setSelected(project)
    setTasksLoading(true)
    try {
      const t = await loadTasks(project.id)
      setTasks(t)
      if (focusTaskId) {
        const target = t.find((x) => x.id === focusTaskId)
        if (target) setDrawerTask(target)
      }
    } catch {
      setError('Could not load tasks.')
    } finally {
      setTasksLoading(false)
    }
  }

  // Workspace switch: full reset (reused without remounting — Phase 3 lesson).
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    setSelected(null)
    setTasks([])
    setDrawerTask(null)
    loadProjects()
      .then((p) => { if (!cancelled) setProjects(p) })
      .catch(() => { if (!cancelled) setError('Could not load projects.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [loadProjects])

  // Consume the projectId/taskId deep-link params (pinned shape, spec §3),
  // once, after the project list has loaded — same consume-and-strip pattern
  // as WorkspaceDetail's fileId/comments handling.
  useEffect(() => {
    const projectId = searchParams.get('projectId')
    if (!projectId || loading) return
    const project = projects.find((p) => p.id === projectId)
    const taskId = searchParams.get('taskId')
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('projectId')
      next.delete('taskId')
      return next
    }, { replace: true })
    if (!project) return   // stale link (project deleted / no access) — fail silently
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openProject(project, taskId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, projects, searchParams])

  const refreshTasks = async () => {
    if (!selected) return
    try { setTasks(await loadTasks(selected.id)) } catch { /* keep stale list */ }
  }

  const createProject = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await api.createProject(slug, { name: newName.trim() })
      setNewName('')
      setProjects(await loadProjects())
    } catch (err) {
      setError(err.data?.error || 'Could not create project.')
    } finally {
      setCreating(false)
    }
  }

  const createTask = async () => {
    if (!newTaskTitle.trim() || !selected) return
    try {
      await api.createTask(selected.id, { title: newTaskTitle.trim() })
      setNewTaskTitle('')
      await refreshTasks()
    } catch (err) {
      setError(err.data?.error || 'Could not create task.')
    }
  }

  const changeTaskStatus = async (task, status) => {
    try {
      await api.updateTask(task.id, { status })
      await refreshTasks()
    } catch (err) {
      setError(err.data?.error || 'Could not update task.')
    }
  }

  const changeProjectStatus = async (status) => {
    if (!selected) return
    try {
      await api.updateProject(selected.id, { status })
      setSelected({ ...selected, status })
      setProjects(await loadProjects())
    } catch (err) {
      setError(err.data?.error || 'Could not update project.')
    }
  }

  const deleteProject = async () => {
    if (!selected) return
    if (!confirm(`Delete project "${selected.name}"?`)) return
    try {
      await api.deleteProject(selected.id)
      setSelected(null)
      setProjects(await loadProjects())
    } catch (err) {
      if (err.status === 409) {
        if (confirm(`${err.data?.error || 'Project has open tasks.'}\n\nDelete them too?`)) {
          await api.deleteProject(selected.id, true)
          setSelected(null)
          setProjects(await loadProjects())
        }
      } else {
        setError(err.data?.error || 'Could not delete project.')
      }
    }
  }

  if (loading) return <div className="projects-tab__loading"><div className="spinner" /></div>

  // ── Project list ──
  if (!selected) {
    return (
      <div className="projects-tab">
        {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
        {canWrite && (
          <div className="projects-tab__new">
            <input
              type="text"
              value={newName}
              placeholder="New project name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button className="btn btn--primary" onClick={createProject} disabled={creating || !newName.trim()}>
              {creating ? 'Creating…' : 'New project'}
            </button>
          </div>
        )}
        {projects.length === 0 ? (
          <div className="projects-tab__empty">No projects yet.</div>
        ) : (
          <div className="projects-tab__grid">
            {projects.map((p) => (
              <button key={p.id} className="project-card card" onClick={() => openProject(p)}>
                <div className="project-card__name">{p.name}</div>
                <div className="project-card__meta">
                  <span className={`badge project-card__status--${p.status}`}>{PROJECT_STATUS_LABELS[p.status]}</span>
                  <span className="mono">{p.open_task_count} open · {p.done_task_count} done</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Project page ──
  const columns = BOARD_COLUMNS.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status === status),
  }))

  return (
    <div className="projects-tab">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
      <div className="project-page__header">
        <button className="link-btn" onClick={() => { setSelected(null); setDrawerTask(null) }}>← Projects</button>
        <h3>{selected.name}</h3>
        {canWrite ? (
          <select
            className="ops-filter-select"
            value={selected.status}
            onChange={(e) => changeProjectStatus(e.target.value)}
          >
            {Object.entries(PROJECT_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ) : (
          <span className="badge">{PROJECT_STATUS_LABELS[selected.status]}</span>
        )}
        <div className="project-page__actions">
          <button
            className={`btn btn--secondary btn--sm ${view === 'board' ? 'project-page__view--active' : ''}`}
            onClick={() => setView('board')}
          >Board</button>
          <button
            className={`btn btn--secondary btn--sm ${view === 'list' ? 'project-page__view--active' : ''}`}
            onClick={() => setView('list')}
          >List</button>
          {(isAdmin || d1User?.workspacePermissions?.[slug] === 'admin' || selected.created_by === d1User?.userId) && (
            <button className="btn btn--danger btn--sm" onClick={deleteProject}>Delete</button>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="projects-tab__new">
          <input
            type="text"
            value={newTaskTitle}
            placeholder="New task title"
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createTask()}
          />
          <button className="btn btn--secondary btn--sm" onClick={createTask} disabled={!newTaskTitle.trim()}>
            Add task
          </button>
        </div>
      )}

      {tasksLoading ? (
        <div className="projects-tab__loading"><div className="spinner" /></div>
      ) : view === 'board' ? (
        <div className="task-board">
          {columns.map((col) => (
            <div key={col.status} className="task-board__column">
              <div className="task-board__column-title label">
                {STATUS_LABELS[col.status]} <span className="mono">{col.tasks.length}</span>
              </div>
              {col.tasks.map((t) => (
                <div key={t.id} className="task-card" onClick={() => setDrawerTask(t)}>
                  <div className="task-card__title">{t.title}</div>
                  <div className="task-card__meta">
                    {t.assignee_username && <span className="task-card__assignee mono">{t.assignee_username}</span>}
                    {t.due_date && <span className="task-card__due mono">{formatDue(t.due_date)}</span>}
                    {t.comment_count > 0 && <span className="task-card__comments mono">💬 {t.comment_count}</span>}
                  </div>
                  {canWrite && (
                    <select
                      className="ops-filter-select task-card__status"
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => changeTaskStatus(t, e.target.value)}
                    >
                      {BOARD_COLUMNS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </select>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Assignee</th><th>Due</th><th>Status</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="folder-row" onClick={() => setDrawerTask(t)}>
                <td>{t.title}</td>
                <td className="mono">{t.assignee_username || '—'}</td>
                <td className="mono">{formatDue(t.due_date) || '—'}</td>
                <td><span className="badge">{STATUS_LABELS[t.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {drawerTask && (
        <TaskDrawer
          workspaceSlug={slug}
          task={drawerTask}
          canWrite={canWrite}
          onClose={() => setDrawerTask(null)}
          onChanged={refreshTasks}
        />
      )}
    </div>
  )
}
