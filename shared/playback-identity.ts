import type { PlaywrightPlaybackEvent } from './playback'
import { parseSourceLocation } from './lib/source-location'
import { summaryEntryName } from './test-names'

export interface PlaybackCaseEntry { caseKey?: string; id?: string; name: string; title?: string; location?: string }
export interface PlaybackSourceDeclaration { file: string; title: string }
export interface PlaybackEventKey { caseKey: string; attemptKey: string }
/** Aligned with the exact event array in the same RunDetail response. */
export interface PlaybackIdentity { eventKeys: Array<PlaybackEventKey | null> }

export function playbackLocationKey(location: string): string {
  const { file, line } = parseSourceLocation(location)
  return line === undefined ? file : `${file}:${line}`
}

export function playbackCaseKey(entry: PlaybackCaseEntry): string {
  return entry.caseKey ?? `${entry.name}@${entry.location ? playbackLocationKey(entry.location) : ''}`
}

/** Lines disambiguate duplicate titles; a unique declared test may move lines. */
export function reconcilePlaybackCases<T extends PlaybackCaseEntry>(
  known: readonly PlaybackCaseEntry[], attempts: readonly T[], sources: readonly PlaybackSourceDeclaration[] = [],
): Array<{ entry: PlaybackCaseEntry; declared: boolean; attempts: T[] }> {
  const cases: Array<{ entry: PlaybackCaseEntry; declared: boolean; attempts: T[] }> = []
  const byKey = new Map<string, typeof cases[number]>()
  const byNameFile = new Map<string, typeof cases>()
  const groupKey = (entry: PlaybackCaseEntry) => JSON.stringify([entry.name, entry.location === undefined ? null : parseSourceLocation(entry.location).file])
  const add = (entry: PlaybackCaseEntry, declared: boolean) => {
    const existing = byKey.get(playbackCaseKey(entry))
    if (existing) return existing
    const item = { entry, declared, attempts: [] as T[] }
    cases.push(item)
    byKey.set(playbackCaseKey(entry), item)
    const key = groupKey(entry)
    const group = byNameFile.get(key) ?? []
    group.push(item)
    byNameFile.set(key, group)
    return item
  }
  for (const entry of known) add(entry, true)
  for (const attempt of attempts) {
    const file = attempt.location === undefined ? undefined : parseSourceLocation(attempt.location).file
    const candidates = byNameFile.get(groupKey(attempt)) ?? []
    const exact = byKey.get(playbackCaseKey(attempt))
    const unique = attempt.caseKey === undefined && candidates.length === 1 && (candidates[0].declared || sources.filter((source) =>
      source.file === file && (source.title === attempt.title || summaryEntryName(source.title) === attempt.name)).length === 1)
    const owner = exact ?? (unique ? candidates[0] : add(attempt, false))
    owner.attempts.push(attempt)
  }
  return cases
}

/** Timestamp wins over Map insertion order when a rerun returns to an old line. */
export function latestPlaybackAttempt<T extends { startedAt?: string; endedAt?: string }>(attempts: readonly T[]): T | undefined {
  return attempts.reduce<T | undefined>((latest, attempt) => !latest
    || (attempt.endedAt ?? attempt.startedAt ?? '') >= (latest.endedAt ?? latest.startedAt ?? '') ? attempt : latest, undefined)
}

interface EventAttempt extends PlaybackCaseEntry {
  key: string
  indexes: number[]
  startedAt?: string
  endedAt?: string
}

/** IDs associate concurrent workers; ambiguous legacy steps remain unassigned. */
export function buildPlaybackIdentity(
  events: readonly PlaywrightPlaybackEvent[], known: readonly PlaybackCaseEntry[] = [], sources: readonly PlaybackSourceDeclaration[] = [],
): PlaybackIdentity {
  const attempts: EventAttempt[] = []
  const active = new Set<EventAttempt>()
  for (const [index, event] of events.entries()) {
    const location = 'location' in event.test ? event.test.location : undefined
    const matching = [...active].filter((attempt) => event.test.id
      ? attempt.id === event.test.id
      : attempt.name === event.test.name && (location === undefined || attempt.location === undefined || attempt.location === location))
    let attempt = event.type !== 'test-begin' && matching.length === 1 ? matching[0] : undefined
    if (!attempt && (event.type === 'test-begin' || event.type === 'test-end' || matching.length === 0)) {
      // An orphan legacy step can be shown, but never attached to either of two workers.
      attempt = { ...event.test, key: String(index), indexes: [] }
      attempts.push(attempt)
      if (event.type !== 'test-end') active.add(attempt)
    }
    if (!attempt) continue
    if (location !== undefined) attempt.location = location
    attempt.indexes.push(index)
    if (event.type === 'test-begin') attempt.startedAt = event.time
    if (event.type === 'test-end') { attempt.endedAt = event.time; active.delete(attempt) }
  }
  const eventKeys: PlaybackIdentity['eventKeys'] = events.map(() => null)
  for (const item of reconcilePlaybackCases(known, attempts, sources)) {
    for (const attempt of item.attempts) {
      for (const index of attempt.indexes) eventKeys[index] = { caseKey: playbackCaseKey(item.entry), attemptKey: attempt.key }
    }
  }
  return { eventKeys }
}
