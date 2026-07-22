import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiClient } from '../../api/client'

function describeAction(item) {
  // Minimal human labels for the event types this phase actually produces
  // plus everything Phase 1/2 already write — extend as new actions ship.
  const labels = {
    'comment.create': 'commented',
    'comment.edit': 'edited a comment',
    'comment.delete': 'deleted a comment',
    'file.upload': 'uploaded a file',
    'file.replace': 'replaced a file',
    'file.delete': 'deleted a file',
    'file.move': 'moved a file',
    'folder.create': 'created a folder',
    'folder.rename': 'renamed a folder',
    'folder.delete': 'deleted a folder',
    'folder.move': 'moved a folder',
    'member.invite': 'invited a member',
    'member.join': 'joined the workspace',
    'member.permission_change': 'changed a member\'s permission',
    'member.remove': 'removed a member',
    'workspace.update': 'updated workspace settings',
  }
  return labels[item.action] || item.action
}

export default function ActivityTab({ slug }) {
  const api = useApiClient()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState(null)

  // Reused across workspace navigation without remounting (WorkspaceDetail
  // refetches on slug change rather than remounting). loadMore is a click
  // handler, not an effect, so it can't use an effect-cleanup cancel flag
  // the way the main load effect below does — this ref (updated only via
  // effect, never during render) is what lets it recognize a stale in-flight
  // "load more" once the workspace slug has since changed.
  const slugRef = useRef(slug)
  useEffect(() => { slugRef.current = slug }, [slug])

  const load = useCallback(async (before) => {
    const data = await api.listActivity(slug, before ? { before } : {})
    return data.activity
  }, [api, slug])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadingMore(false)
    setItems([])
    setError(null)
    setHasMore(true)
    load()
      .then((data) => {
        if (cancelled) return
        setItems(data)
        setHasMore(data.length === 50)
      })
      .catch(() => { if (!cancelled) setError('Could not load activity.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load])

  const loadMore = async () => {
    if (items.length === 0) return
    const requestSlug = slug
    setLoadingMore(true)
    try {
      const more = await load(items[items.length - 1].created_at)
      if (slugRef.current !== requestSlug) return
      setItems((prev) => [...prev, ...more])
      setHasMore(more.length === 50)
      setError(null)
    } catch {
      if (slugRef.current === requestSlug) setError('Could not load more activity.')
    } finally {
      if (slugRef.current === requestSlug) setLoadingMore(false)
    }
  }

  if (loading) return <div className="activity-tab__loading"><div className="spinner" /></div>

  return (
    <div className="activity-tab">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
      {items.length === 0 ? (
        <div className="activity-tab__empty">No activity yet.</div>
      ) : (
        <ul className="activity-tab__list">
          {items.map((item) => (
            <li key={item.id} className="activity-tab__item">
              <span className="mono">{new Date(item.created_at).toLocaleString()}</span>
              {' — '}
              <strong>{item.actor_username || 'Someone'}</strong> {describeAction(item)}
            </li>
          ))}
        </ul>
      )}
      {hasMore && items.length > 0 && (
        <button className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
