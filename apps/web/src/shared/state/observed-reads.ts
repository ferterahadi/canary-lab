/** A stream observation supersedes HTTP reads started before it. Tokens also
 * keep an old request's finally block from releasing a newer request. */
export function createObservedReads() {
  const pending = new Map<string, symbol>()
  return {
    begin(key: string): symbol | null {
      if (pending.has(key)) return null
      const token = Symbol(key)
      pending.set(key, token)
      return token
    },
    current(key: string, token: symbol): boolean {
      return pending.get(key) === token
    },
    finish(key: string, token: symbol): void {
      if (pending.get(key) === token) pending.delete(key)
    },
    invalidate(key: string): void { pending.delete(key) },
    clear(): void { pending.clear() },
  }
}
