/** A promise the test settles by hand, so it decides exactly when a pending
 *  request, read or spawn completes — and can assert what the code under test
 *  shows while it is still in flight. */
export function deferred<T = unknown>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
