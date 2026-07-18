// worker/src/routes/briefs.js
import { jsonResponse, errorResponse } from '../cors.js'
import { logAudit } from '../audit.js'

export function verifyServiceKey(request, env) {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return token.length > 0 && token === env.WSL_SERVICE_KEY
}

export function _parseBriefRow(row) {
  const safeParse = (val, fallback) => {
    if (!val) return fallback
    try { return JSON.parse(val) } catch { return fallback }
  }
  return {
    date: row.date,
    status: row.status,
    agent_count: row.agent_count,
    validation_errors: row.validation_errors,
    leads: safeParse(row.leads_json, []),
    actions: safeParse(row.actions_json, []),
    world_news: safeParse(row.world_news_json, []),
    economy: safeParse(row.economy_json, {}),
    threats: safeParse(row.threats_json, []),
    pipeline: safeParse(row.pipeline_json, {}),
    content: safeParse(row.content_json, {}),
    security: safeParse(row.security_json, []),
    raw_brief: row.raw_brief,
    created_at: row.created_at,
  }
}

export async function handlePostBrief(request, env) {
  if (!verifyServiceKey(request, env)) {
    return errorResponse('Unauthorized', 401)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return errorResponse('date is required and must be YYYY-MM-DD', 400)
  }
  if (!body.raw_brief || body.raw_brief.length < 10) {
    return errorResponse('raw_brief is required', 400)
  }

  const existing = await env.DB
    .prepare('SELECT date FROM briefs WHERE date = ?')
    .bind(body.date)
    .first()

  await env.DB
    .prepare(`
      INSERT OR REPLACE INTO briefs (
        date, status, agent_count, validation_errors,
        leads_json, actions_json, world_news_json, economy_json,
        threats_json, pipeline_json, content_json, security_json,
        raw_brief, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE(
          (SELECT created_at FROM briefs WHERE date = ?),
          datetime('now')
        ))
    `)
    .bind(
      body.date,
      body.status ?? 'completed',
      body.agent_count ?? 0,
      body.validation_errors ?? 0,
      body.leads_json ?? '[]',
      body.actions_json ?? '[]',
      body.world_news_json ?? '[]',
      body.economy_json ?? '{}',
      body.threats_json ?? '[]',
      body.pipeline_json ?? '{}',
      body.content_json ?? '{}',
      body.security_json ?? '[]',
      body.raw_brief,
      body.date,
    )
    .run()

  await logAudit(env, 'gw-os-service', existing ? 'brief.updated' : 'brief.created', {
    resourceType: 'brief',
    resourceId: body.date,
    agent_count: body.agent_count,
    status: body.status,
  })

  return jsonResponse(
    { date: body.date, action: existing ? 'updated' : 'created' },
    existing ? 200 : 201,
  )
}

export async function handleListBriefs(request, env, user) {
  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100)
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0'), 0)
  const from = url.searchParams.get('from') ?? null
  const to = url.searchParams.get('to') ?? null

  const conditions = []
  const binds = []
  if (from) { conditions.push('date >= ?'); binds.push(from) }
  if (to)   { conditions.push('date <= ?'); binds.push(to) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [countRow, rows] = await Promise.all([
    env.DB
      .prepare(`SELECT COUNT(*) as total FROM briefs ${where}`)
      .bind(...binds)
      .first(),
    env.DB
      .prepare(
        `SELECT date, status, agent_count, validation_errors, created_at
         FROM briefs ${where}
         ORDER BY date DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all(),
  ])

  return jsonResponse({
    briefs: rows.results,
    pagination: { total: countRow?.total ?? 0, limit, offset },
  })
}

export async function handleGetLatestBrief(request, env, user) {
  const row = await env.DB
    .prepare('SELECT * FROM briefs ORDER BY date DESC LIMIT 1')
    .first()

  if (!row) {
    return errorResponse('No briefs found', 404)
  }

  return jsonResponse(_parseBriefRow(row))
}

export async function handleGetBrief(request, env, user, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return errorResponse('Invalid date format — use YYYY-MM-DD', 400)
  }

  const row = await env.DB
    .prepare('SELECT * FROM briefs WHERE date = ?')
    .bind(date)
    .first()

  if (!row) {
    return errorResponse(`Brief not found: ${date}`, 404)
  }

  return jsonResponse(_parseBriefRow(row))
}
