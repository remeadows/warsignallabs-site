#!/usr/bin/env node
/* global process */
// Hits every GET endpoint on the portal API and snapshots {status, bodyKeys}.
// Run once against the OLD deployed worker, then again against the NEW
// (refactored) worker after deploy, and diff the two JSON files — any
// difference means the refactor changed behavior.
//
// Usage:
//   node worker/scripts/smoke-test.js --base-url https://api.warsignallabs.net \
//     --token "$BEARER_JWT" --out /tmp/smoke-before.json
//
// The token is a real Clerk-issued JWT — copy the "Authorization: Bearer ..."
// header value from a signed-in browser session's Network tab (any request
// to api.warsignallabs.net). Tokens are short-lived; capture a fresh one for
// each run (before AND after) so both runs authenticate as the same user.

import { writeFileSync } from 'node:fs'

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    out[args[i].replace(/^--/, '')] = args[i + 1]
  }
  return out
}

const { 'base-url': baseUrl, token, out } = parseArgs()
if (!baseUrl || !token || !out) {
  console.error('Usage: node smoke-test.js --base-url <url> --token <jwt> --out <file.json>')
  process.exit(1)
}

// Every GET endpoint from worker/src/router.js. Params use real IDs/slugs
// that exist in production (see portal-app/CONTEXT.md D1 tables).
const ENDPOINTS = [
  { method: 'GET', path: '/api/health', auth: false },
  { method: 'GET', path: '/api/me', auth: true },
  { method: 'GET', path: '/api/workspaces', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs/files', auth: true },
  { method: 'GET', path: '/api/workspaces/warsignallabs/folders', auth: true },
  { method: 'GET', path: '/api/users', auth: true },
  { method: 'GET', path: '/api/audit-log', auth: true },
  { method: 'GET', path: '/api/admin/analytics', auth: true },
  { method: 'GET', path: '/api/dashboard/projects', auth: true },
  { method: 'GET', path: '/api/briefs/latest', auth: true },
  { method: 'GET', path: '/api/briefs', auth: true },
]

function sortedKeys(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') return []
  if (Array.isArray(obj)) {
    return obj.length > 0 ? sortedKeys(obj[0], `${prefix}[]`) : [`${prefix}[]`]
  }
  return Object.keys(obj).sort().flatMap((k) =>
    [`${prefix}${prefix ? '.' : ''}${k}`, ...sortedKeys(obj[k], `${prefix}${prefix ? '.' : ''}${k}`)]
  )
}

async function main() {
  const results = {}
  for (const ep of ENDPOINTS) {
    const key = `${ep.method} ${ep.path}`
    try {
      const response = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: ep.auth ? { Authorization: `Bearer ${token}` } : {},
      })
      const status = response.status
      let bodyKeys = []
      try {
        const body = await response.json()
        bodyKeys = sortedKeys(body)
      } catch {
        bodyKeys = ['<non-JSON body>']
      }
      results[key] = { status, bodyKeys }
      console.log(`${status} ${key}`)
    } catch (err) {
      results[key] = { status: 'ERROR', error: err.message }
      console.log(`ERROR ${key}: ${err.message}`)
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2))
  console.log(`\nWrote ${out}`)
}

main()
