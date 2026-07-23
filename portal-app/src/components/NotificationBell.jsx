import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiClient } from '../api/client'

const POLL_MS = 60_000

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

export default function NotificationBell() {
  const api = useApiClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const boxRef = useRef(null)

  const refreshUnreadCount = useCallback(async () => {
    try {
      const data = await api.listNotifications({ unread: '1', limit: '50' })
      setUnreadCount(data.notifications.length)
    } catch {
      // Silent — a failed poll shouldn't disrupt the rest of the UI.
    }
  }, [api])

  useEffect(() => {
    refreshUnreadCount()
    const id = setInterval(refreshUnreadCount, POLL_MS)
    return () => clearInterval(id)
  }, [refreshUnreadCount])

  useEffect(() => {
    if (!open) return
    api.listNotifications({ limit: '20' }).then((data) => setItems(data.notifications)).catch(() => {})
  }, [open, api])

  useEffect(() => {
    const onClickOutside = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const openItem = async (item) => {
    if (!item.read_at) {
      try {
        await api.markNotificationsRead({ ids: [item.id] })
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read_at: new Date().toISOString() } : i)))
        setUnreadCount((c) => Math.max(0, c - 1))
      } catch {
        // Navigation should still proceed even if marking read fails.
      }
    }
    setOpen(false)
    if (item.link) navigate(item.link)
  }

  const markAllRead = async () => {
    try {
      await api.markNotificationsRead({ all: true })
      setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at || new Date().toISOString() })))
      setUnreadCount(0)
    } catch {
      // Leave state unchanged; user can retry.
    }
  }

  return (
    <div className="notification-bell" ref={boxRef}>
      <button className="notification-bell__trigger" onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        <BellIcon />{unreadCount > 0 && <span className="notification-bell__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notification-bell__dropdown">
          <div className="notification-bell__header">
            <span>Notifications</span>
            <button className="link-btn" onClick={markAllRead}>Mark all read</button>
          </div>
          {items.length === 0 ? (
            <div className="notification-bell__empty">No notifications.</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`notification-bell__item ${item.read_at ? '' : 'notification-bell__item--unread'}`}
                onClick={() => openItem(item)}
              >
                <div className="notification-bell__title">{item.title}</div>
                <div className="notification-bell__time mono">{new Date(item.created_at).toLocaleString()}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
