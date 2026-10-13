import type { FastifyReply } from 'fastify'
import { errorMessage } from '../../../../shared/lib/error-message'

// The repo's HTTP-facing failure shape, in one place.
//
// A route-layer failure is `Object.assign(new Error(msg), { statusCode: N })` —
// the route reads `statusCode` off the thrown value rather than matching on an
// error class. That idiom is fine; what does not scale is RE-WRAPPING a caught
// throw at each site:
//
//     throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 409 })
//
// The `String(err)` arm is defensive at any ONE of those sites — the things that
// actually throw there are fs and git errors, which are always `Error` — so it
// read as an untestable branch once per copy. Collapsed here it is covered once,
// and a genuine non-Error throw still arrives with a readable message instead of
// as `undefined`.

/** A failure the route layer will turn into an HTTP response. */
export type HttpFailure = Error & { statusCode: number }

/**
 * Stamp a caught throw with the status the route layer should answer with,
 * preserving the original error (and its stack) when there is one.
 */
export function httpFailure(err: unknown, statusCode: number): HttpFailure {
  return Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode })
}

/**
 * Answer 404 with the route layer's `{ error: '<thing> not found' }` body. It
 * returns the payload rather than sending it, so a handler stays one line:
 * `if (!detail) return notFound(reply, 'run')`.
 */
export function notFound(reply: FastifyReply, thing: string): { error: string } {
  reply.code(404)
  return { error: `${thing} not found` }
}

/**
 * The status a caught throw asks the route layer to answer with: its own
 * `statusCode` when that is a real HTTP status, else 500. A missing, non-numeric
 * or out-of-range value (a library's internal code, a NaN) must never reach
 * `reply.code`, which would turn the failure into a different one.
 */
export function statusCodeOf(err: unknown): number {
  const code = (err as { statusCode?: unknown } | null | undefined)?.statusCode
  return typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599 ? code : 500
}

/**
 * Answer a caught throw with its status (`statusCodeOf`) and the route layer's
 * `{ error: <message> }` body. Like `notFound`, it returns the payload so a
 * catch block stays one line: `return replyFailure(reply, err)`.
 */
export function replyFailure(reply: FastifyReply, err: unknown, fallback?: string): { error: string } {
  reply.code(statusCodeOf(err))
  return { error: errorMessage(err, fallback) }
}
