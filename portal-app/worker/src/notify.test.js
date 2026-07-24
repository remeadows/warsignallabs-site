import { describe, it, expect } from 'vitest'
import { escapeHtml, buildEmailHtml } from './notify.js'

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
