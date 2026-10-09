/** A non-null, non-array object — the shape parsed JSON must have before its
 *  fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
