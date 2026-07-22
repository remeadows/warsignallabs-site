// worker/src/pagination.js
// Opaque seek-pagination cursor combining created_at with the row's unique id.
// created_at has only second-level precision (SQLite datetime('now')), so
// multiple rows can share a timestamp; a created_at-only cursor silently
// drops same-second rows that fall on a page boundary. Seeking on the pair
// keeps page boundaries exact no matter how many rows share a timestamp.

const DELIMITER = '::'

export function encodeCursor(row) {
  return `${row.created_at}${DELIMITER}${row.id}`
}

export function decodeCursor(cursor) {
  const idx = cursor.lastIndexOf(DELIMITER)
  if (idx === -1) return null
  const createdAt = cursor.slice(0, idx)
  const id = cursor.slice(idx + DELIMITER.length)
  if (!createdAt || !id) return null
  return { createdAt, id }
}

/** Seek-pagination WHERE fragment + bindings for `ORDER BY created_at DESC, id DESC`. */
export function seekCondition(cursor, columnPrefix = '') {
  return {
    clause: `(${columnPrefix}created_at < ? OR (${columnPrefix}created_at = ? AND ${columnPrefix}id < ?))`,
    params: [cursor.createdAt, cursor.createdAt, cursor.id],
  }
}
