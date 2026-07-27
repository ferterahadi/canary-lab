import type { RunDetail } from '../run-store'

export interface CompactRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  statusLine: string
}

export interface NormalizedRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  passedNames: string[]
  passedIds: string[]
  failedNames: string[]
  failedIds: string[]
  skippedNames: string[]
  skippedIds: string[]
  notRunNames: string[]
  statusLine: string
}

export function compactCounts(counts: NormalizedRunCounts): CompactRunCounts {
  return {
    totalKnown: counts.totalKnown,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    notRun: counts.notRun,
    statusLine: counts.statusLine,
  }
}

export function normalizeRunCounts(summary: RunDetail['summary'] | null): NormalizedRunCounts {
  const summaryWithKnownTests = summary as (RunDetail['summary'] & { knownTests?: unknown }) | null
  const knownTests = Array.isArray(summaryWithKnownTests?.knownTests)
    ? summaryWithKnownTests.knownTests
    : []
  const knownEntries = knownTests.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as { id?: unknown; name?: unknown }
    const name = typeof value.name === 'string' ? value.name : ''
    if (!name) return []
    return [{
      id: typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined,
      name,
    }]
  })
  const passedNames = uniqueStrings(summary?.passedNames ?? [])
  const passedIds = uniqueStrings(((summary as { passedIds?: unknown[] } | null)?.passedIds) ?? [])
  const failedNames = uniqueStrings((summary?.failed ?? []).map((entry) => entry.name))
  const failedIds = uniqueStrings((summary?.failed ?? []).map((entry) => (entry as { id?: unknown }).id))
  const skippedNames = uniqueStrings(summary?.skippedNames ?? [])
  const skippedIds = uniqueStrings(((summary as { skippedIds?: unknown[] } | null)?.skippedIds) ?? [])
  const hasResultIds = passedIds.length > 0 || failedIds.length > 0 || skippedIds.length > 0
  const accountedIds = new Set([...passedIds, ...failedIds, ...skippedIds])
  const accountedNames = new Set([...passedNames, ...failedNames, ...skippedNames])
  const notRunNames = knownEntries
    .filter((entry) => {
      if (hasResultIds && entry.id) return !accountedIds.has(entry.id)
      return !accountedNames.has(entry.name)
    })
    .map((entry) => entry.name)
  const totalKnown = knownEntries.length > 0 ? knownEntries.length : numberOrZero(summary?.total)
  const passed = typeof summary?.passed === 'number' ? summary.passed : passedNames.length
  const failed = failedNames.length
  const skipped = typeof summary?.skipped === 'number' ? summary.skipped : skippedNames.length
  const notRun = knownEntries.length > 0
    ? notRunNames.length
    : Math.max(0, totalKnown - passed - failed - skipped)

  return {
    totalKnown,
    passed,
    failed,
    skipped,
    notRun,
    passedNames,
    passedIds,
    failedNames,
    failedIds,
    skippedNames,
    skippedIds,
    notRunNames,
    statusLine: statusLineForCounts({ totalKnown, passed, failed, skipped, notRun }),
  }
}

export function statusLineForCounts(counts: Pick<NormalizedRunCounts, 'totalKnown' | 'passed' | 'failed' | 'skipped' | 'notRun'>): string {
  const parts = [`${counts.passed}/${counts.totalKnown} passed`, `${counts.failed} failed`]
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  parts.push(`${counts.notRun} not run`)
  return parts.join(', ')
}

export function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
