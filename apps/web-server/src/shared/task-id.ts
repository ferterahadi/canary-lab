import crypto from 'crypto'

// The two record-id styles the server mints. Each prefix keeps the style it
// already had, so stored ids never change shape across releases.

/** `<prefix>_<hex>`: flights, feature plans, coverage jobs, discovery repairs. */
export function newTaskId(prefix: string, bytes = 6): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`
}

/** `<prefix>-<base36 time>-<6 base36 chars>`: drafts, evaluation tasks and
 *  getting-started sessions. */
export function newTimedTaskId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
