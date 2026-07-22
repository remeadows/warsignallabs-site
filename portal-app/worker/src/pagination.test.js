import { describe, it, expect } from 'vitest'
import { encodeCursor, decodeCursor, seekCondition } from './pagination.js'

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a row with created_at and id', () => {
    const row = { created_at: '2026-07-22 10:15:30', id: 'ntf-abc123' }
    const cursor = encodeCursor(row)
    expect(decodeCursor(cursor)).toEqual({ createdAt: row.created_at, id: row.id })
  })

  it('returns null for a string with no delimiter', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })

  it('returns null when the created_at half is empty', () => {
    expect(decodeCursor('::ntf-abc123')).toBeNull()
  })

  it('returns null when the id half is empty', () => {
    expect(decodeCursor('2026-07-22 10:15:30::')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })
})

describe('seekCondition', () => {
  it('builds an unprefixed seek clause with matching bind params', () => {
    const cursor = { createdAt: '2026-07-22 10:15:30', id: 'ntf-abc123' }
    const { clause, params } = seekCondition(cursor)
    expect(clause).toBe('(created_at < ? OR (created_at = ? AND id < ?))')
    expect(params).toEqual(['2026-07-22 10:15:30', '2026-07-22 10:15:30', 'ntf-abc123'])
  })

  it('applies a column prefix to every comparison', () => {
    const cursor = { createdAt: '2026-07-22 10:15:30', id: 'aud-xyz789' }
    const { clause } = seekCondition(cursor, 'a.')
    expect(clause).toBe('(a.created_at < ? OR (a.created_at = ? AND a.id < ?))')
  })
})
