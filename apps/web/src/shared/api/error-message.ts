import { errorMessage } from '@shared/lib/error-message'
import { isRecord } from '@shared/lib/is-record'
import { ApiError } from './internal'

/** The copy a UI line shows for anything a `catch` received. A non-2xx response
 *  shows the server's own `reason`/`error` rather than the bare `HTTP 409`, a
 *  dropped fetch shows a connection hint instead of the browser's `Failed to
 *  fetch`, and everything else falls through to `errorMessage`. */
export function displayError(err: unknown, fallback?: string): string {
  if (err instanceof ApiError) {
    // Only a non-empty string is copy; a structured or numeric field would
    // print as "42" or "[object Object]", which says less than the status.
    const body = isRecord(err.body) ? err.body : {}
    for (const field of [body.reason, body.error]) {
      if (typeof field === 'string' && field) return field
    }
    return err.message
  }
  if (isNetworkError(err)) {
    return 'Lost connection to server. Check that the server is running.'
  }
  return errorMessage(err, fallback)
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('fetch') || msg.includes('network') || msg.includes('load failed')
}
