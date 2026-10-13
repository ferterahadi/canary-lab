export interface PollUntilOptions<T> {
  timeoutMs?: number
  intervalMs?: number
  /** The error message when the deadline passes, given the last value read —
   *  so a timeout names the state the poll was stuck in, not just that it was. */
  timeoutMessage: (last: T) => string
}

/** Read until `predicate` accepts the value, then return it. Every read is
 *  checked before the deadline is: a value that settles on the final read still
 *  wins, and a timeout always reports a value that was actually read. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 3000, intervalMs = 10, timeoutMessage }: PollUntilOptions<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > deadline) throw new Error(timeoutMessage(value))
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
