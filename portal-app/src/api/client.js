/**
 * API client for the portal Worker backend.
 * All requests include the Clerk JWT for authentication.
 *
 * Usage in components:
 *   import { useApiClient } from '../api/client'
 *   const api = useApiClient()
 *   const workspaces = await api.listWorkspaces()
 */

import { useAuth } from '@clerk/clerk-react'
import { useMemo } from 'react'

const API_URL = import.meta.env.VITE_API_URL || ''

async function apiFetch(path, getToken, options = {}) {
  const headers = { ...options.headers }

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json'
  }

  // Add auth token if available
  if (getToken) {
    try {
      const token = await getToken()
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }
    } catch {
      // Token retrieval failed — continue without auth
    }
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    const error = new Error(`API error: ${response.status}`)
    error.status = response.status
    try {
      error.data = await response.json()
    } catch {
      // ignore parse errors
    }
    throw error
  }

  // Handle 204 No Content
  if (response.status === 204) return null

  // Handle binary responses (file downloads)
  if (options.responseType === 'blob') {
    return response
  }

  return response.json()
}

/**
 * React hook that returns an API client bound to the current Clerk session.
 */
export function useApiClient() {
  const { getToken } = useAuth()

  return useMemo(() => ({
    // Current user (D1-authoritative role + permissions)
    getMe: () => apiFetch('/api/me', getToken),

    // Health
    health: () => apiFetch('/api/health', getToken),

    // Workspaces
    listWorkspaces: () => apiFetch('/api/workspaces', getToken),
    getWorkspace: (slug) => apiFetch(`/api/workspaces/${slug}`, getToken),

    // Folders
    listFolderContents: (workspaceSlug, folderId) =>
      apiFetch(`/api/workspaces/${workspaceSlug}/folders${folderId ? `/${folderId}` : ''}`, getToken),
    createFolder: (workspaceSlug, name, parentFolderId) =>
      apiFetch(`/api/workspaces/${workspaceSlug}/folders`, getToken, {
        method: 'POST',
        body: JSON.stringify({ name, parent_folder_id: parentFolderId || null }),
      }),
    renameFolder: (folderId, name) =>
      apiFetch(`/api/folders/${folderId}`, getToken, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    deleteFolder: (folderId) =>
      apiFetch(`/api/folders/${folderId}`, getToken, { method: 'DELETE' }),
    moveFolder: (folderId, parentFolderId) =>
      apiFetch(`/api/folders/${folderId}/move`, getToken, {
        method: 'PATCH',
        body: JSON.stringify({ parent_folder_id: parentFolderId }),
      }),

    // Files
    listFiles: (workspaceSlug, category) =>
      apiFetch(`/api/workspaces/${workspaceSlug}/files${category ? `?category=${category}` : ''}`, getToken),
    uploadFile: (workspaceSlug, file, category, folderId) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('category', category || 'documents')
      if (folderId) formData.append('folder_id', folderId)
      return apiFetch(`/api/workspaces/${workspaceSlug}/files`, getToken, {
        method: 'POST',
        body: formData,
      })
    },
    moveFile: (fileId, folderId) =>
      apiFetch(`/api/files/${fileId}/move`, getToken, {
        method: 'PATCH',
        body: JSON.stringify({ folder_id: folderId }),
      }),
    downloadFile: (fileId) => apiFetch(`/api/files/${fileId}/download`, getToken, { responseType: 'blob' }),
    replaceFile: (fileId, file) => {
      const formData = new FormData()
      formData.append('file', file)
      return apiFetch(`/api/files/${fileId}`, getToken, {
        method: 'PUT',
        body: formData,
      })
    },
    getFileVersions: (fileId) => apiFetch(`/api/files/${fileId}/versions`, getToken),
    deleteFile: (fileId) => apiFetch(`/api/files/${fileId}`, getToken, { method: 'DELETE' }),

    // Users (admin)
    listUsers: () => apiFetch('/api/users', getToken),
    createUser: (data) => apiFetch('/api/users', getToken, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    changeRole: (userId, role) => apiFetch(`/api/users/${userId}/role`, getToken, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
    deactivateUser: (userId) => apiFetch(`/api/users/${userId}/deactivate`, getToken, { method: 'POST' }),
    activateUser: (userId) => apiFetch(`/api/users/${userId}/activate`, getToken, { method: 'POST' }),
    getUserWorkspaces: (userId) => apiFetch(`/api/users/${userId}/workspaces`, getToken),
    updateUserWorkspaces: (userId, assignments) =>
      apiFetch(`/api/users/${userId}/workspaces`, getToken, {
        method: 'PATCH',
        body: JSON.stringify({ assignments }),
      }),

    // Workspaces (admin)
    createWorkspace: (data) => apiFetch('/api/workspaces', getToken, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    updateWorkspace: (slug, data) => apiFetch(`/api/workspaces/${slug}`, getToken, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    deleteWorkspace: (slug) => apiFetch(`/api/workspaces/${slug}`, getToken, { method: 'DELETE' }),

    // Audit log (admin)
    getAuditLog: (params = {}) =>
      apiFetch(`/api/audit-log?${new URLSearchParams(params)}`, getToken),

    // Admin analytics
    getAnalytics: () => apiFetch('/api/admin/analytics', getToken),
  }), [getToken])
}
