import { useState, useEffect, useCallback } from 'react'
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

  const load = useCallback(async (before) => {
    const data = await api.listActivity(slug, before ? { before } : {})
    setHasMore(data.activity.length === 50)
    return data.activity
  }, [api, slug])

  useEffect(() => {
    setLoading(true)
    load().then(setItems).finally(() => setLoading(false))
  }, [load])

  const loadMore = async () => {
    if (items.length === 0) return
    setLoadingMore(true)
    try {
      const more = await load(items[items.length - 1].created_at)
      setItems((prev) => [...prev, ...more])
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading) return <div className="activity-tab__loading"><div className="spinner" /></div>

  return (
    <div className="activity-tab">
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
