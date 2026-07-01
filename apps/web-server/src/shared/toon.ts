// TOON (Token-Oriented Object Notation) encoding for agent-facing list results.
// TOON's token win over our already-compact JSON comes from arrays of UNIFORM
// objects with PRIMITIVE values: the field names are emitted once as a header
// row (`[N]{col,...}:`) instead of being repeated on every element.
//
// Encoding itself is delegated to @toon-format/toon (the reference encoder — it
// owns the spec's quoting/escaping rules). Our job here is to normalize rows to
// a uniform scalar shape FIRST, so the array actually reaches the tabular form
// instead of degrading to the verbose `-` list form (which costs MORE tokens
// than compact JSON). NOTE: @toon-format/toon is ESM-only, so this require()
// needs Node >=20.19 / >=22.12 — see package.json `engines`.
import { encode } from '@toon-format/toon'

type Primitive = string | number | boolean | null

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Encode an array of records as a TOON table. Rows are normalized to a uniform
 * scalar shape — the union of every row's keys (first-seen order), with a
 * missing key filled as `null` and any non-primitive value serialized to a
 * compact-JSON string — so the array always reaches the tabular form. Values
 * that need flattening for the table to be useful (e.g. nested arrays the agent
 * should read structurally) should be projected by the caller BEFORE this; the
 * JSON-string fallback here only keeps stray nested fields lossless.
 *
 * Empty arrays and non-array/non-record values fall through to compact JSON.
 */
export function encodeToonTable(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return JSON.stringify(value)
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!isPlainObject(row)) return JSON.stringify(value)
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  const normalized = (value as Record<string, unknown>[]).map((row) => {
    const out: Record<string, Primitive> = {}
    for (const col of columns) {
      const cell = row[col]
      out[col] = cell === undefined ? null : isPrimitive(cell) ? cell : JSON.stringify(cell)
    }
    return out
  })
  return encode(normalized)
}
