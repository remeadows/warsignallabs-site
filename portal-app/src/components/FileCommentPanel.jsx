import CommentThread from './CommentThread'

export default function FileCommentPanel({ workspaceSlug, file, onClose }) {
  return (
    <div className="slide-over-overlay" onClick={onClose}>
      <div className="slide-over" onClick={(e) => e.stopPropagation()}>
        <div className="slide-over__header">
          <h3>Comments — {file.filename}</h3>
          <button className="modal__close" onClick={onClose}>&times;</button>
        </div>
        <CommentThread workspaceSlug={workspaceSlug} entityType="file" entityId={file.id} />
      </div>
    </div>
  )
}
