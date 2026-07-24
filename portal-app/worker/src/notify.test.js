import { describe, it, expect, vi, afterEach } from 'vitest'
import { escapeHtml, buildEmailHtml, notifyWorkspaceEvent } from './notify.js'

describe('escapeHtml', () => {
  it('escapes script tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml('Tom & "Jerry" <3>')).toBe('Tom &amp; &quot;Jerry&quot; &lt;3&gt;')
  })

  it('leaves values with nothing to escape unchanged', () => {
    expect(escapeHtml('admin')).toBe('admin')
  })
})

describe('buildEmailHtml', () => {
  it('escapes a raw title so it cannot render as markup', () => {
    const out = buildEmailHtml('Invite: <img src=x onerror=alert(1)>', [])
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('does not double-escape a title containing entities-worthy characters', () => {
    const out = buildEmailHtml("New comment in Tom's R&D", [])
    expect(out).toContain('Tom&#39;s R&amp;D')
    expect(out).not.toContain('&amp;#39;')
    expect(out).not.toContain('&amp;amp;')
  })

  it('does not render an unescaped body line as markup', () => {
    const out = buildEmailHtml('Title', [`<strong>Workspace:</strong> ${escapeHtml('<script>evil()</script>')}`])
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;evil()&lt;/script&gt;')
    expect(out).toContain('<strong>Workspace:</strong>')
  })
})

describe('notifyWorkspaceEvent title contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the raw title in the subject and inbox row; escapes it only in the email HTML', async () => {
    const inserts = []
    const env = {
      RESEND_API_KEY: 'test-key',
      DB: {
        prepare: (sql) => ({
          bind: (...args) => ({
            run: async () => {
              inserts.push({ sql, args })
              return {}
            },
          }),
        }),
      },
    }
    const sent = []
    vi.stubGlobal('fetch', async (url, opts) => {
      sent.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ id: 'resend-1' }) }
    })

    let task
    notifyWorkspaceEvent(env, { waitUntil: (p) => { task = p } }, {
      eventType: 'comment.create',
      workspaceId: 'ws-1',
      title: "New comment in Tom's R&D",
      bodyLines: ['<strong>someone@example.com</strong> commented:'],
      recipientOverride: [{ email: 'member@example.com', userId: 'u-1', emailPref: 'all' }],
    })
    await task

    // Inbox row (rendered as React text): raw title, no entities
    const inboxInsert = inserts.find((i) => i.sql.includes('notification_inbox'))
    expect(inboxInsert.args[3]).toBe("New comment in Tom's R&D")

    // Plain-text email subject: raw title, no entities
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe("[WSL Portal] New comment in Tom's R&D")

    // HTML email body: escaped exactly once
    expect(sent[0].html).toContain('Tom&#39;s R&amp;D')
    expect(sent[0].html).not.toContain('&amp;#39;')
  })
})
