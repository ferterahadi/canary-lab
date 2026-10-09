import { playbackLocationKey } from './playback-identity'

export interface SummaryTestIdentity {
  name: string
  id?: string
  location?: string
  allowNameFallback?: boolean
}

/** An identified sibling is never a substitute for a missing test. Legacy
 * records can recover by location or a unique name, but ambiguity stays visible. */
export function findSummaryTest<T extends { name: string; id?: string; location?: string }>(
  entries: readonly T[], identity: SummaryTestIdentity,
): T | undefined {
  if (identity.id) {
    const identified = entries.filter((entry) => entry.id === identity.id)
    if (identified.length) return identified.length === 1 ? identified[0] : undefined
  }
  if (identity.allowNameFallback === false) return undefined
  const named = entries.filter((entry) => entry.name === identity.name)
  if (identity.id && named.some((entry) => entry.id)) return undefined
  if (identity.location) {
    const located = named.filter((entry) => entry.location
      && playbackLocationKey(entry.location) === playbackLocationKey(identity.location!))
    return located.length === 1 ? located[0] : undefined
  }
  return named.length === 1 ? named[0] : undefined
}
