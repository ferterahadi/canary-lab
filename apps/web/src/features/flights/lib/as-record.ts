import { isRecord } from '@shared/lib/is-record'

/** `value` as a field map when it is a plain object, else null — for walking
 *  stage evidence and suite config, whose shapes are unvalidated JSON, with
 *  `asRecord(x)?.field` / `asRecord(x) ?? {}` instead of a guard per level. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
