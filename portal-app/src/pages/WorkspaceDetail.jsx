import { useParams } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useUser } from '@clerk/clerk-react'
import { useApiClient } from '../api/client'
import './WorkspaceDetail.css'

const CATEGORIES = ['invoices', 'documents', 'deliverables', 'reports']

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fileIcon(mimeType) {
  if (!mimeType) return '...'
  if (mimeType.includes('pdf')) return 'PDF'
  if (mimeType.includes('word') || mimeType.includes('document')) return 'DOC'
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'XLS'
  if (mimeType.includes('image')) return 'IMG'
  if (mimeType.includes('zip')) return 'ZIP'
  if (mimeType.includes('text')) return 'TXT'
  return 'FILE'
}

export default function WorkspaceDetail() {
  const { slug } = useParams()
  const { user } = useUser()
  const api = useApiClient()

  const role = user?.publicMetadata?.role || 'client'
  const canDelete = role === 'admin'

  const [workspace, setWorkspace] = useState(null)
  const [files, setFiles] = useState([])
  const [activeTab, setActiveTab] = useState('documents')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Upload permission: admin/owner by role, or workspace-level write/admin permission
  const canUpload = role === 'admin' || role === 'owner' ||
    (workspace?.userPermission === 'write' || workspace?.userPermission === 'admin')

  // Upload state
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  const fetchFiles = useCallback(async (category) => {
    try {
      const data = await api.listFiles(slug, category)
      setFiles(data.files || [])
    } catch (err) {
      console.error('Failed to fetch files:', err)
      setFiles([])
    }
  }, [api, slug])

  const fetchWorkspace = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.getWorkspace(slug)
      setWorkspace(data.workspace)
      await fetchFiles(activeTab)
    } catch (err) {
      setError(err.status === 403 ? 'You do not have access to this workspace.' : 'Failed to load workspace.')
    } finally {
      setLoading(false)
    }
  }, [api, slug, activeTab, fetchFiles])

  useEffect(() => {
    fetchWorkspace()
  }, [slug]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (workspace) {
      fetchFiles(activeTab)
    }
  }, [activeTab]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return
    setUploading(true)

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      setUploadProgress(`Uploading ${file.name} (${i + 1}/${fileList.length})...`)
      try {
        await api.uploadFile(slug, file, activeTab)
      } catch (err) {
        const msg = err.data?.error || err.message
        setError(`Upload failed for ${file.name}: ${msg}`)
        break
      }
    }

    setUploading(false)
    setUploadProgress('')
    await fetchFiles(activeTab)
  }

  const handleDownload = async (file) => {
    try {
      const response = await api.downloadFile(file.id)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(`Download failed: ${err.message}`)
    }
  }

  const handleDelete = async (file) => {
    if (!confirm(`Delete "${file.filename}"? This cannot be undone.`)) return
    try {
      await api.deleteFile(file.id)
      await fetchFiles(activeTab)
    } catch (err) {
      setError(`Delete failed: ${err.message}`)
    }
  }

  // Drag and drop handlers
  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (canUpload) setDragOver(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (canUpload && e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files)
    }
  }

  if (loading) {
    return (
      <div className="workspace fade-in">
        <div className="workspace__loading">
          <div className="spinner" />
          <span>Loading workspace...</span>
        </div>
      </div>
    )
  }

  if (error && !workspace) {
    return (
      <div className="workspace fade-in">
        <div className="workspace__error">{error}</div>
      </div>
    )
  }

  if (!workspace) {
    return <div className="workspace-not-found">Workspace not found.</div>
  }

  return (
    <div className="workspace fade-in">
      <div className="workspace__header">
        <span className="label">// Workspace</span>
        <h1 style={{ color: workspace.color }}>{workspace.name}</h1>
        <div className="workspace__meta">
          {workspace.fileCount} files &middot; {workspace.memberCount} members
        </div>
      </div>

      <div className="workspace__tabs">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            className={`workspace__tab ${activeTab === cat ? 'workspace__tab--active' : ''}`}
            onClick={() => setActiveTab(cat)}
          >
            {cat.charAt(0).toUpperCase() + cat.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="workspace__alert workspace__alert--error">
          {error}
          <button className="workspace__alert-dismiss" onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      <div
        className={`workspace__content card ${dragOver ? 'workspace__content--dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="workspace__toolbar">
          <span className="label">{activeTab} &middot; {files.length} file{files.length !== 1 ? 's' : ''}</span>
          {canUpload && (
            <div className="workspace__upload-actions">
              {uploading && <span className="workspace__upload-status mono">{uploadProgress}</span>}
              <button
                className="btn btn--primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading...' : 'Upload File'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => handleUpload(e.target.files)}
              />
            </div>
          )}
        </div>

        {files.length === 0 ? (
          <div className="workspace__files-empty">
            {canUpload
              ? `No ${activeTab} uploaded yet. Drag and drop files here or click Upload.`
              : `No ${activeTab} available yet.`}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
                <th>Size</th>
                <th>Uploaded By</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map(file => (
                <tr key={file.id}>
                  <td><span className="file-type-badge">{fileIcon(file.mime_type)}</span></td>
                  <td className="file-name">{file.filename}</td>
                  <td className="mono">{formatBytes(file.size_bytes)}</td>
                  <td className="mono">{file.uploaded_by_name || '—'}</td>
                  <td>{formatDate(file.created_at)}</td>
                  <td className="file-actions">
                    <button className="btn btn--secondary btn--sm" onClick={() => handleDownload(file)}>
                      Download
                    </button>
                    {canDelete && (
                      <button className="btn btn--danger btn--sm" onClick={() => handleDelete(file)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dragOver && canUpload && (
        <div className="workspace__drop-overlay">
          <div className="workspace__drop-message">Drop files to upload to {activeTab}</div>
        </div>
      )}
    </div>
  )
}
