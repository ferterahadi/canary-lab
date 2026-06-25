// Canary Lab numbers every test in a feature with a stable id so a person can
// find the same case across the Tests column, Playback, and Coverage Ledger.
//
// The id is the test's 1-based rank when all of the feature's tests are ordered
// by (spec file, line) — its *source position*. That ordering is identical no
// matter which view derives it (every view reads the same spec files), so id
// #N points at the same test everywhere, even though each view displays its
// rows in a different order (source / execution / status). The id is NOT a row
// number; in a status- or execution-sorted view the badges read non-sequential
// on purpose.

export interface TestLocationLike {
  file?: string
  line?: number
}

/** Stable map key for a test, by its source location. */
export function testNumberKey(file: string | undefined, line: number | undefined): string {
  return `${file ?? ''}:${line ?? 0}`
}

/**
 * Parse a Playwright `location` string (`e2e/foo.spec.ts:34` or
 * `e2e/foo.spec.ts:34:5`) into a file + line. Returns line 0 when absent.
 */
export function parseLocation(location: string | undefined): { file: string; line: number } | null {
  if (!location) return null
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(location)
  if (!match) return { file: location, line: 0 }
  return { file: match[1], line: Number(match[2]) }
}

/**
 * Build the canonical numbering for a feature's tests. Items are de-duplicated
 * by (file, line), sorted by file then line, and assigned 1-based ids. The
 * returned map is keyed by {@link testNumberKey} so callers look up by the same
 * (file, line) they already hold.
 */
export function buildTestNumbering(items: TestLocationLike[]): Map<string, number> {
  const unique = new Map<string, { file: string; line: number }>()
  for (const item of items) {
    const file = item.file ?? ''
    const line = item.line ?? 0
    const key = testNumberKey(file, line)
    if (!unique.has(key)) unique.set(key, { file, line })
  }
  const sorted = [...unique.entries()].sort(([, a], [, b]) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  const numbering = new Map<string, number>()
  sorted.forEach(([key], index) => numbering.set(key, index + 1))
  return numbering
}

/**
 * Legacy specs (e.g. the `cns_*` features) bake an ordinal into the test title
 * itself (`"1. gateway is healthy"`). The UI now owns numbering, so strip a
 * single leading ordinal for display to avoid a doubled `#1 1. …`. Only a bare
 * leading `N.` / `N)` is removed; the rest of the title is untouched.
 */
export function stripLeadingTestOrdinal(title: string): string {
  return title.replace(/^\s*\d+[.)]\s+/, '')
}
