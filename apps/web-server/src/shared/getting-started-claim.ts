interface ClaimOwner<T> {
  attach(sessionId: string, target: T): void
  abandon(sessionId: string): void
}

interface GettingStartedClaim<T> {
  attach(target: T): void
  abandon(): void
}

export function gettingStartedClaim<T>(
  owner: ClaimOwner<T> | undefined,
  sessionId: string | null,
): GettingStartedClaim<T> | null {
  if (!owner || !sessionId) return null
  return {
    attach: (target) => owner.attach(sessionId, target),
    abandon: () => owner.abandon(sessionId),
  }
}

/** Own only a newly acquired claim. Once attached, its durable target owns completion. */
export async function withGettingStartedClaim<T, R>(
  claim: GettingStartedClaim<T> | null,
  run: (attach: (target: T) => void) => R | Promise<R>,
): Promise<R> {
  let attached = false
  let failed = false
  try {
    return await run((target) => {
      claim?.attach(target)
      attached = true
    })
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (claim && !attached) {
      try {
        claim.abandon()
      } catch (error) {
        // Cleanup must not replace the launch failure that explains what went wrong.
        if (!failed) throw error
      }
    }
  }
}
