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
