import { useParams } from 'react-router-dom'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiClient } from '../api/client'
import { usePortalAuth } from '../contexts/PortalAuth'
import './WorkspaceDetail.css'

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

function FolderTreeNodes({ nodes, selectedId, onSelect, depth, excludeFolderId }) {
  return nodes.map(node => {
    if (node.id === excludeFolderId) return null
    return (
      <div key={node.id}>
        <button
          className={`folder-tree__item ${selectedId === node.id ? 'folder-tree__item--selected' : ''}`}
          style={{ paddingLeft: `${depth * 1.2}rem` }}
          onClick={() => onSelect(node.id)}
        >
          {node.name}
        </button>
        {node.children?.length > 0 && (
          <FolderTreeNodes
            nodes={node.children}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth + 1}
            excludeFolderId={excludeFolderId}
          />
        )}
      </div>
    )
  })
}

function parseApiError(err, fallback) {
  if (err.status === 403) return 'Permission denied.'
  if (err.status === 409) return err.data?.error || 'A folder with that name already exists.'
  return err.data?.error || err.message || fallback
}

export default function WorkspaceDetail() {
  const { slug } = useParams()
  const { role, isAdmin } = usePortalAuth()
  const api = useApiClient()

  const canDelete = isAdmin

  const [workspace, setWorkspace] = useState(null)
  const [folders, setFolders] = useState([])
  const [files, setFiles] = useState([])
  const [breadcrumbs, setBreadcrumbs] = useState([])
  const [currentFolderId, setCurrentFolderId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Upload permission
  const canUpload = role === 'admin' || role === 'owner' ||
    (workspace?.userPermission === 'write' || workspace?.userPermission === 'admin')
  const canWrite = canUpload

  // Upload state
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [replacing, setReplacing] = useState(null)
  const fileInputRef = useRef(null)
  const replaceInputRef = useRef(null)

  // Folder management state
  const [showNewFolderModal, setShowNewFolderModal] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renamingFolder, setRenamingFolder] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [folderActionLoading, setFolderActionLoading] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState(null)

  // File move state
  const [movingFile, setMovingFile] = useState(null)
  const [folderTree, setFolderTree] = useState([])
  const [moveTargetId, setMoveTargetId] = useState(null)
  const [moveLoading, setMoveLoading] = useState(false)

  const fetchContents = useCallback(async (folderId) => {
    try {
      const data = await api.listFolderContents(slug, folderId)
      setFolders(data.folders || [])
      setFiles(data.files || [])
      setBreadcrumbs(data.breadcrumbs || [])
      setCurrentFolderId(data.currentFolderId || null)
    } catch (err) {
      console.error('Failed to fetch folder contents:', err)
      setFolders([])
      setFiles([])
    }
  }, [api, slug])

  const fetchWorkspace = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.getWorkspace(slug)
      setWorkspace(data.workspace)
      await fetchContents(null)
    } catch (err) {
      setError(err.status === 403 ? 'You do not have access to this workspace.' : 'Failed to load workspace.')
    } finally {
      setLoading(false)
    }
  }, [api, slug, fetchContents])

  useEffect(() => {
    fetchWorkspace()
  }, [slug]) // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToFolder = async (folderId) => {
    setLoading(true)
    setError(null)
    try {
      await fetchContents(folderId)
    } catch {
      setError('Failed to load folder.')
    } finally {
      setLoading(false)
    }
  }

  // ── Upload ──
  const handleUpload = async (fileList) => {
    if (!fileList || fileList.length === 0) return
    setUploading(true)

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      setUploadProgress(`Uploading ${file.name} (${i + 1}/${fileList.length})...`)
      try {
        await api.uploadFile(slug, file, 'documents', currentFolderId)
      } catch (err) {
        const msg = err.data?.error || err.message
        setError(`Upload failed for ${file.name}: ${msg}`)
        break
      }
    }

    setUploading(false)
    setUploadProgress('')
    await fetchContents(currentFolderId)
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
      await fetchContents(currentFolderId)
    } catch (err) {
      setError(`Delete failed: ${err.message}`)
    }
  }

  const handleReplace = (file) => {
    setReplacing(file.id)
    replaceInputRef.current?.click()
  }

  const handleReplaceFile = async (e) => {
    const newFile = e.target.files?.[0]
    if (!newFile || !replacing) {
      setReplacing(null)
      return
    }
    setUploading(true)
    setUploadProgress(`Replacing with ${newFile.name}...`)
    try {
      await api.replaceFile(replacing, newFile)
      await fetchContents(currentFolderId)
    } catch (err) {
      const msg = err.data?.error || err.message
      setError(`Replace failed: ${msg}`)
    } finally {
      setUploading(false)
      setUploadProgress('')
      setReplacing(null)
      if (replaceInputRef.current) replaceInputRef.current.value = ''
    }
  }

  // ── Folder CRUD ──
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return
    setFolderActionLoading(true)
    try {
      await api.createFolder(slug, newFolderName.trim(), currentFolderId)
      setShowNewFolderModal(false)
      setNewFolderName('')
      await fetchContents(currentFolderId)
    } catch (err) {
      setError(parseApiError(err, 'Create folder failed'))
    } finally {
      setFolderActionLoading(false)
    }
  }

  const handleRenameFolder = async () => {
    if (!renameValue.trim() || !renamingFolder) return
    setFolderActionLoading(true)
    try {
      await api.renameFolder(renamingFolder.id, renameValue.trim())
      setRenamingFolder(null)
      setRenameValue('')
      await fetchContents(currentFolderId)
    } catch (err) {
      setError(parseApiError(err, 'Rename failed'))
    } finally {
      setFolderActionLoading(false)
    }
  }

  const handleDeleteFolder = async () => {
    if (!deletingFolder) return
    setFolderActionLoading(true)
    try {
      await api.deleteFolder(deletingFolder.id)
      setDeletingFolder(null)
      await fetchContents(currentFolderId)
    } catch (err) {
      const msg = parseApiError(err, 'Delete folder failed')
      setError(msg)
      setDeletingFolder(null)
    } finally {
      setFolderActionLoading(false)
    }
  }

  const openMoveFilePicker = async (file) => {
    setMovingFile(file)
    setMoveTargetId(null)
    try {
      const data = await api.listFolderContents(slug, null)
      setFolderTree(await buildFolderTree(data.folders || [], null))
    } catch {
      setError('Failed to load folder tree.')
      setMovingFile(null)
    }
  }

  const buildFolderTree = async (rootFolders, parentId) => {
    const tree = []
    for (const folder of rootFolders) {
      const node = { ...folder, children: [] }
      try {
        const data = await api.listFolderContents(slug, folder.id)
        if (data.folders?.length) {
          node.children = await buildFolderTree(data.folders, folder.id)
        }
      } catch {
        // leaf node
      }
      tree.push(node)
    }
    return tree
  }

  const handleMoveFile = async () => {
    if (!movingFile) return
    setMoveLoading(true)
    try {
      await api.moveFile(movingFile.id, moveTargetId)
      setMovingFile(null)
      await fetchContents(currentFolderId)
    } catch (err) {
      const msg = parseApiError(err, 'Move failed')
      setError(msg)
      setMovingFile(null)
    } finally {
      setMoveLoading(false)
    }
  }

  // ── Drag & Drop ──
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

  // ── Renders ──
  if (loading && !workspace) {
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

  const totalItems = folders.length + files.length

  return (
    <div className="workspace fade-in">
      <div className="workspace__header">
        <span className="label">// Workspace</span>
        <h1 style={{ color: workspace.color }}>{workspace.name}</h1>
        <div className="workspace__meta">
          {workspace.fileCount} files &middot; {workspace.memberCount} members
        </div>
      </div>

      {/* Breadcrumb Navigation */}
      <nav className="breadcrumbs" aria-label="Folder navigation">
        <button className="breadcrumb__item breadcrumb__root" onClick={() => navigateToFolder(null)}>
          {workspace.name}
        </button>
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.id} className="breadcrumb__segment">
            <span className="breadcrumb__sep">/</span>
            {i === breadcrumbs.length - 1 ? (
              <span className="breadcrumb__current">{crumb.name}</span>
            ) : (
              <button className="breadcrumb__item" onClick={() => navigateToFolder(crumb.id)}>
                {crumb.name}
              </button>
            )}
          </span>
        ))}
      </nav>

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
          <span className="label">
            {folders.length} folder{folders.length !== 1 ? 's' : ''} &middot; {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
          {canWrite && (
            <div className="workspace__upload-actions">
              {uploading && <span className="workspace__upload-status mono">{uploadProgress}</span>}
              <button
                className="btn btn--secondary"
                onClick={() => { setNewFolderName(''); setShowNewFolderModal(true) }}
                disabled={uploading}
              >
                New Folder
              </button>
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
              <input
                ref={replaceInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={handleReplaceFile}
              />
            </div>
          )}
        </div>

        {loading && workspace ? (
          <div className="workspace__loading" style={{ minHeight: '200px' }}>
            <div className="spinner" />
          </div>
        ) : totalItems === 0 ? (
          <div className="workspace__files-empty">
            {canWrite
              ? 'This folder is empty. Create a folder or upload a file.'
              : 'This folder is empty.'}
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
              {/* Folders first */}
              {folders.map(folder => (
                <tr key={`folder-${folder.id}`} className="folder-row" onDoubleClick={() => navigateToFolder(folder.id)}>
                  <td><span className="file-type-badge file-type-badge--folder">FLD</span></td>
                  <td className="file-name">
                    <button className="folder-link" onClick={() => navigateToFolder(folder.id)}>
                      {folder.name}
                    </button>
                  </td>
                  <td className="mono">—</td>
                  <td className="mono">—</td>
                  <td>{formatDate(folder.created_at)}</td>
                  <td className="file-actions">
                    {canWrite && (
                      <>
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => { setRenamingFolder(folder); setRenameValue(folder.name) }}
                        >
                          Rename
                        </button>
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() => setDeletingFolder(folder)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}

              {/* Files */}
              {files.map(file => (
                <tr key={file.id}>
                  <td><span className="file-type-badge">{fileIcon(file.mime_type)}</span></td>
                  <td className="file-name">
                    {file.filename}
                    {file.version > 1 && (
                      <span className="version-badge" title={`Version ${file.version}`}>v{file.version}</span>
                    )}
                  </td>
                  <td className="mono">{formatBytes(file.size_bytes)}</td>
                  <td className="mono">{file.uploaded_by_name || '—'}</td>
                  <td>{formatDate(file.created_at)}</td>
                  <td className="file-actions">
                    <button className="btn btn--secondary btn--sm" onClick={() => handleDownload(file)}>
                      Download
                    </button>
                    {canUpload && (
                      <>
                        <button
                          className="btn btn--accent btn--sm"
                          onClick={() => handleReplace(file)}
                          disabled={uploading}
                        >
                          Replace
                        </button>
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => openMoveFilePicker(file)}
                        >
                          Move
                        </button>
                      </>
                    )}
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
          <div className="workspace__drop-message">Drop files to upload here</div>
        </div>
      )}

      {/* New Folder Modal */}
      {showNewFolderModal && (
        <div className="modal-overlay" onClick={() => setShowNewFolderModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Folder</h3>
            <input
              type="text"
              className="modal__input"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
              autoFocus
              maxLength={100}
            />
            <div className="modal__actions">
              <button className="btn btn--secondary" onClick={() => setShowNewFolderModal(false)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleCreateFolder} disabled={folderActionLoading || !newFolderName.trim()}>
                {folderActionLoading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Folder Modal */}
      {renamingFolder && (
        <div className="modal-overlay" onClick={() => setRenamingFolder(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rename Folder</h3>
            <input
              type="text"
              className="modal__input"
              placeholder="New name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRenameFolder()}
              autoFocus
              maxLength={100}
            />
            <div className="modal__actions">
              <button className="btn btn--secondary" onClick={() => setRenamingFolder(null)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleRenameFolder} disabled={folderActionLoading || !renameValue.trim()}>
                {folderActionLoading ? 'Renaming...' : 'Rename'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Folder Modal */}
      {deletingFolder && (
        <div className="modal-overlay" onClick={() => setDeletingFolder(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Folder</h3>
            {(deletingFolder.file_count > 0 || deletingFolder.folder_count > 0) ? (
              <>
                <p className="modal__text">
                  Cannot delete <strong>{deletingFolder.name}</strong> — it contains{' '}
                  {[
                    deletingFolder.folder_count > 0 && `${deletingFolder.folder_count} folder${deletingFolder.folder_count !== 1 ? 's' : ''}`,
                    deletingFolder.file_count > 0 && `${deletingFolder.file_count} file${deletingFolder.file_count !== 1 ? 's' : ''}`,
                  ].filter(Boolean).join(' and ')}.
                  Move or delete the contents first.
                </p>
                <div className="modal__actions">
                  <button className="btn btn--secondary" onClick={() => setDeletingFolder(null)}>OK</button>
                </div>
              </>
            ) : (
              <>
                <p className="modal__text">
                  Delete folder <strong>{deletingFolder.name}</strong>? This cannot be undone.
                </p>
                <div className="modal__actions">
                  <button className="btn btn--secondary" onClick={() => setDeletingFolder(null)}>Cancel</button>
                  <button className="btn btn--danger" onClick={handleDeleteFolder} disabled={folderActionLoading}>
                    {folderActionLoading ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Move File Modal */}
      {movingFile && (
        <div className="modal-overlay" onClick={() => setMovingFile(null)}>
          <div className="modal modal--move" onClick={(e) => e.stopPropagation()}>
            <h3>Move "{movingFile.filename}"</h3>
            <p className="modal__text">Select destination folder:</p>
            <div className="folder-tree">
              <button
                className={`folder-tree__item folder-tree__root ${moveTargetId === null ? 'folder-tree__item--selected' : ''}`}
                onClick={() => setMoveTargetId(null)}
              >
                / (root)
              </button>
              <FolderTreeNodes
                nodes={folderTree}
                selectedId={moveTargetId}
                onSelect={setMoveTargetId}
                depth={1}
                excludeFolderId={null}
              />
            </div>
            <div className="modal__actions">
              <button className="btn btn--secondary" onClick={() => setMovingFile(null)}>Cancel</button>
              <button className="btn btn--primary" onClick={handleMoveFile} disabled={moveLoading}>
                {moveLoading ? 'Moving...' : 'Move Here'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
