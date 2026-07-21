// worker/src/audit.js
// Every mutation writes an audit_log row. Never blocks the response on failure.

export async function logAudit(env, userId, action, details = {}) {
  try {
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, workspace_id, metadata_json, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        id,
        userId,
        action,
        details.resourceType || null,
        details.resourceId || null,
        details.workspaceId || null,
        JSON.stringify(details),
        details.ipAddress || null,
      )
      .run()
  } catch (err) {
    console.error('Audit log write failed:', err.message)
  }
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
}
