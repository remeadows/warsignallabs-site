// worker/src/notify.js
// Fire-and-forget email notifications via Resend, using ctx.waitUntil() so
// the primary API response is never blocked.

/**
 * Send an email via Resend API. Fire-and-forget — never blocks the primary action.
 * Logs to the notifications table for auditing.
 */
export async function sendEmail(env, { to, subject, html, text, eventType, workspaceId, recipientUserId, metadata }) {
  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email notification')
    return null
  }

  const fromEmail = env.RESEND_FROM_EMAIL || 'portal@warsignallabs.net'
  const fromName = env.RESEND_FROM_NAME || 'WarSignalLabs Portal'

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html || undefined,
        text: text || subject,
      }),
    })

    const result = await response.json()
    const resendId = result.id || null
    const status = response.ok ? 'sent' : 'failed'

    if (!response.ok) {
      console.error('Resend API error:', JSON.stringify(result))
    }

    // Log notification to D1
    const notifId = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO notifications (id, event_type, workspace_id, recipient_email, recipient_user_id, subject, body_text, metadata_json, status, resend_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      notifId,
      eventType || 'general',
      workspaceId || null,
      Array.isArray(to) ? to.join(', ') : to,
      recipientUserId || null,
      subject,
      text || subject,
      metadata ? JSON.stringify(metadata) : null,
      status,
      resendId,
    ).run()

    return { id: resendId, status }
  } catch (err) {
    console.error('Email send failed:', err.message)
    return null
  }
}

/**
 * Resolve notification recipients for a workspace event.
 * Returns { admins: [{email, userId}], workspaceMembers: [{email, userId}] }
 */
export async function resolveRecipients(env, workspaceId) {
  // All active admins
  const admins = await env.DB.prepare(
    "SELECT id, email FROM users WHERE role = 'admin' AND status = 'active' AND email IS NOT NULL",
  ).all()

  // Workspace members (clients with workspace assignment)
  let members = { results: [] }
  if (workspaceId) {
    members = await env.DB.prepare(
      `SELECT u.id, u.email FROM users u
       INNER JOIN user_workspaces uw ON uw.user_id = u.id
       WHERE uw.workspace_id = ? AND u.status = 'active' AND u.email IS NOT NULL`,
    ).bind(workspaceId).all()
  }

  return {
    admins: admins.results.map((u) => ({ email: u.email, userId: u.id })),
    workspaceMembers: members.results.map((u) => ({ email: u.email, userId: u.id })),
  }
}

/**
 * Escape user-controlled text before interpolating into email HTML.
 */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/**
 * Build a branded HTML email body.
 */
export function buildEmailHtml(title, bodyLines) {
  const lines = bodyLines.map((l) => `<p style="margin:4px 0;color:#333;">${l}</p>`).join('')
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <div style="border-bottom:3px solid #00c8d4;padding-bottom:12px;margin-bottom:20px;">
    <h2 style="margin:0;color:#0a0a0a;">WarSignalLabs Portal</h2>
    <span style="font-size:0.75rem;color:#888;">v0.1.0</span>
  </div>
  <h3 style="color:#0a0a0a;margin-bottom:8px;">${title}</h3>
  ${lines}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
  <p style="font-size:0.75rem;color:#999;">This is an automated notification from portal.warsignallabs.net</p>
</body>
</html>`
}

/**
 * Notify on a workspace event. Sends to admins + workspace members.
 * Admins always receive notifications (full visibility).
 * Client actors are excluded from self-notification.
 * Uses ctx.waitUntil() for non-blocking delivery.
 */
export function notifyWorkspaceEvent(env, ctx, { eventType, workspaceId, workspaceName, title, bodyLines, actorEmail, metadata }) {
  const task = (async () => {
    try {
      const { admins, workspaceMembers } = await resolveRecipients(env, workspaceId)

      // Build admin email set — admins always receive (never excluded)
      const adminEmails = new Set(admins.map((a) => a.email.toLowerCase()))

      // Deduplicate: admins always included, non-admin actors excluded
      const allRecipients = new Map()
      for (const r of [...admins, ...workspaceMembers]) {
        if (!r.email) continue
        const emailLower = r.email.toLowerCase()
        const isActor = emailLower === (actorEmail || '').toLowerCase()
        const isAdmin = adminEmails.has(emailLower)
        // Admins always get notified; non-admins skip if they're the actor
        if (isAdmin || !isActor) {
          allRecipients.set(emailLower, r)
        }
      }

      if (allRecipients.size === 0) return

      const subject = `[WSL Portal] ${title}`
      const html = buildEmailHtml(title, bodyLines)
      const text = bodyLines.join('\n')

      // Send individual emails for per-recipient logging
      for (const [email, recipient] of allRecipients) {
        await sendEmail(env, {
          to: email,
          subject,
          html,
          text,
          eventType,
          workspaceId,
          recipientUserId: recipient.userId,
          metadata,
        })
      }
    } catch (err) {
      console.error('notifyWorkspaceEvent failed:', err.message)
    }
  })()

  // Non-blocking — Worker responds immediately, email sends in background
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
}

/**
 * Check workspace storage against 75% threshold. Fires alert if exceeded.
 */
export function checkStorageThreshold(env, ctx, { workspaceId, workspaceName, workspaceSlug, actorEmail }) {
  const task = (async () => {
    try {
      const ws = await env.DB.prepare(
        'SELECT storage_quota_mb FROM workspaces WHERE id = ?',
      ).bind(workspaceId).first()
      if (!ws || !ws.storage_quota_mb) return

      const usage = await env.DB.prepare(
        'SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM files WHERE workspace_id = ?',
      ).bind(workspaceId).first()

      const usedMb = (usage?.total_bytes || 0) / (1024 * 1024)
      const quotaMb = ws.storage_quota_mb
      const pct = Math.round((usedMb / quotaMb) * 100)

      if (pct >= 75) {
        notifyWorkspaceEvent(env, ctx, {
          eventType: 'workspace.threshold',
          workspaceId,
          workspaceName: workspaceName || workspaceSlug,
          title: `Storage Alert: ${workspaceName || workspaceSlug} at ${pct}%`,
          bodyLines: [
            `<strong>Workspace:</strong> ${workspaceName || workspaceSlug}`,
            `<strong>Storage Used:</strong> ${usedMb.toFixed(1)} MB of ${quotaMb} MB (${pct}%)`,
            `<strong>Status:</strong> ${pct >= 90 ? '🔴 Critical' : '🟡 Warning'} — storage is ${pct >= 90 ? 'nearly full' : 'approaching capacity'}`,
            `Consider archiving old files or increasing the workspace quota.`,
          ],
          actorEmail: null, // admins + members all get threshold alerts
          metadata: { usedMb: usedMb.toFixed(1), quotaMb, pct, workspaceSlug },
        })
      }
    } catch (err) {
      console.error('checkStorageThreshold failed:', err.message)
    }
  })()

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(task)
  }
}
