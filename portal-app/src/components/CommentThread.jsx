import { useState, useEffect, useCallback } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'

function renderBody(body) {
  // Plain text only (spec §3) — split on @mentions for highlighting, nothing else parsed.
  const parts = body.split(/(@[a-zA-Z0-9_-]+)/g)
  return parts.map((part, i) =>
    part.startsWith('@')
      ? <span key={i} className="mention">{part}</span>
      : <span key={i}>{part}</span>,
  )
}

export default function CommentThread({ workspaceSlug, entityType, entityId }) {
  const api = useApiClient()
  const { d1User, isAdmin } = usePortalAuth()
  const wsAdmin = isAdmin || d1User?.workspacePermissions?.[workspaceSlug] === 'admin'
  const myUserId = d1User?.userId

  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.listComments(workspaceSlug, entityType, entityId)
      setComments(data.comments)
      setError(null)
    } catch {
      setError('Could not load comments.')
    } finally {
      setLoading(false)
    }
  }, [api, workspaceSlug, entityType, entityId])

  useEffect(() => { load() }, [load])

  const post = async () => {
    if (!draft.trim()) return
    setPosting(true)
    try {
      await api.createComment(workspaceSlug, {
        entity_type: entityType, entity_id: entityId,
        parent_comment_id: replyTo, body: draft.trim(),
      })
      setDraft('')
      setReplyTo(null)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not post comment.')
    } finally {
      setPosting(false)
    }
  }

  const saveEdit = async (id) => {
    if (!editDraft.trim()) return
    try {
      await api.editComment(id, editDraft.trim())
      setEditingId(null)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not edit comment.')
    }
  }

  const remove = async (id) => {
    if (!confirm('Delete this comment?')) return
    try {
      await api.deleteComment(id)
      await load()
    } catch (err) {
      setError(err.data?.error || 'Could not delete comment.')
    }
  }

  const topLevel = comments.filter((c) => !c.parent_comment_id)
  const repliesTo = (id) => comments.filter((c) => c.parent_comment_id === id)

  const renderComment = (c, isReply) => (
    <div key={c.id} className={`comment ${isReply ? 'comment--reply' : ''}`}>
      <div className="comment__meta mono">
        <strong>{c.author_username}</strong> · {new Date(c.created_at).toLocaleString()}
        {c.edited_at && !c.deleted_at && ' (edited)'}
      </div>
      {c.deleted_at ? (
        <div className="comment__body comment__body--deleted">[deleted]</div>
      ) : editingId === c.id ? (
        <div className="comment__edit">
          <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={2} />
          <button className="btn btn--secondary btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={() => saveEdit(c.id)}>Save</button>
        </div>
      ) : (
        <>
          <div className="comment__body">{renderBody(c.body)}</div>
          <div className="comment__actions">
            {!isReply && <button className="link-btn" onClick={() => setReplyTo(c.id)}>Reply</button>}
            {c.author_id === myUserId && (
              <button className="link-btn" onClick={() => { setEditingId(c.id); setEditDraft(c.body) }}>Edit</button>
            )}
            {(c.author_id === myUserId || wsAdmin) && (
              <button className="link-btn link-btn--danger" onClick={() => remove(c.id)}>Delete</button>
            )}
          </div>
        </>
      )}
      {!isReply && repliesTo(c.id).map((r) => renderComment(r, true))}
    </div>
  )

  if (loading) return <div className="comment-thread__loading"><div className="spinner" /></div>

  return (
    <div className="comment-thread">
      {error && <div className="workspace__alert workspace__alert--error">{error}</div>}
      <div className="comment-thread__list">
        {topLevel.length === 0
          ? <div className="comment-thread__empty">No comments yet.</div>
          : topLevel.map((c) => renderComment(c, false))}
      </div>
      <div className="comment-thread__composer">
        {replyTo && (
          <div className="comment-thread__replying mono">
            Replying… <button className="link-btn" onClick={() => setReplyTo(null)}>cancel</button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment… use @username to mention a member"
          rows={3}
        />
        <button className="btn btn--primary" onClick={post} disabled={posting || !draft.trim()}>
          {posting ? 'Posting…' : 'Post'}
        </button>
      </div>
    </div>
  )
}
