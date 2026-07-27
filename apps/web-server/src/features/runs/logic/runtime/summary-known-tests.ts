import fs from 'fs'
import type { TestCase } from '@playwright/test/reporter'
import { type SummaryForJournalOutcome } from './log-enrichment'
import { getSummaryPath } from './paths'
import { slugify } from './summary-reporter'

export interface KnownTestEntry {
  id: string
  name: string
  title: string
  titlePath?: string[]
  /** The test as Playwright's own `--list` renders it, e.g.
   *  `a.spec.ts › checkout flow › applies a discount`. This is the only form a
   *  `--test-list` entry can take, and it must be captured here rather than
   *  rebuilt from `titlePath` — see `listLineFromTitlePath`. */
  listLine?: string
  location?: string
}

/**
 * Render a `--test-list` entry from the RAW (unfiltered) `TestCase.titlePath()`.
 *
 * The raw array is `['', <project>, <file>, ...suites, <title>]` — index 1 is
 * the project slot, empty unless the config declares named projects. Playwright
 * renders a project as `[name]`, and a `--test-list` entry has to match that
 * rendering exactly: a bare `chromium › a.spec.ts › …` matches ZERO tests and
 * Playwright reports that as a normal empty run, not an error.
 *
 * This is why the line is built here and stored, rather than derived later from
 * `KnownTestEntry.titlePath`: that field is already `filter(Boolean)`-ed, which
 * discards the positions, leaving no way to tell a project name from a file path.
 *
 * The path component is Playwright's own rendering (relative to the common base
 * dir of the discovered spec files), so nothing here computes a path prefix — a
 * wrong prefix is the other way to silently select nothing.
 */
export function listLineFromTitlePath(raw: readonly unknown[]): string | undefined {
  const project = typeof raw[1] === 'string' && raw[1].length > 0 ? `[${raw[1]}]` : undefined
  const rest = raw.slice(2).filter((part): part is string => typeof part === 'string' && part.length > 0)
  // Needs at least the file and the test title to identify anything.
  if (rest.length < 2) return undefined
  return [...(project ? [project] : []), ...rest].join(' › ')
}

export interface ExistingSummary {
  passedNames?: unknown
  passedIds?: unknown
  skippedNames?: unknown
  skippedIds?: unknown
  failed?: unknown
  knownTests?: unknown
}

export function knownTestFromTest(test: TestCase): KnownTestEntry {
  const rawTitlePath = typeof test.titlePath === 'function' ? test.titlePath() : undefined
  const titlePath = rawTitlePath
    ?.filter((part): part is string => typeof part === 'string' && part.length > 0)
  const listLine = rawTitlePath ? listLineFromTitlePath(rawTitlePath) : undefined
  const location = test.location?.file && typeof test.location.line === 'number'
    ? `${test.location.file}:${test.location.line}`
    : undefined
  return {
    id: testIdFor({
      title: test.title,
      ...(titlePath && titlePath.length > 0 ? { titlePath } : {}),
      ...(location ? { location } : {}),
    }),
    name: `test-case-${slugify(test.title)}`,
    title: test.title,
    ...(titlePath && titlePath.length > 0 ? { titlePath } : {}),
    ...(listLine ? { listLine } : {}),
    ...(location ? { location } : {}),
  }
}

export function knownTestsFromExistingSummary(summary: ExistingSummary | null): KnownTestEntry[] {
  const raw = Array.isArray(summary?.knownTests) ? summary.knownTests : []
  const out: KnownTestEntry[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as {
      id?: unknown
      name?: unknown
      title?: unknown
      titlePath?: unknown
      listLine?: unknown
      location?: unknown
    }
    if (typeof value.name !== 'string' || value.name.length === 0) continue
    if (typeof value.title !== 'string' || value.title.length === 0) continue
    const explicitId = typeof value.id === 'string' && value.id.length > 0
    const id = explicitId ? value.id as string : legacyTestIdForName(value.name)
    const titlePath = Array.isArray(value.titlePath)
      ? value.titlePath.filter((part): part is string => typeof part === 'string' && part.length > 0)
      : undefined
    const listLine = typeof value.listLine === 'string' && value.listLine.length > 0 ? value.listLine : undefined
    const location = typeof value.location === 'string' && value.location.length > 0 ? value.location : undefined
    mergeKnownTest(out, {
      id,
      name: value.name,
      title: value.title,
      ...(titlePath && titlePath.length > 0 ? { titlePath } : {}),
      ...(listLine ? { listLine } : {}),
      ...(location ? { location } : {}),
    })
  }
  return out
}

export function mergeKnownTest(knownTests: KnownTestEntry[], entry: KnownTestEntry): { previousId?: string } {
  const entryLogicalKey = knownTestLogicalKey(entry)
  const idx = knownTests.findIndex((known) => known.id === entry.id || (
    known.id.startsWith('legacy-') &&
    known.name === entry.name &&
    known.location === entry.location
  ) || (entryLogicalKey !== undefined && knownTestLogicalKey(known) === entryLogicalKey))
  if (idx < 0) {
    knownTests.push(entry)
    return {}
  }
  const previousId = knownTests[idx].id
  const merged: KnownTestEntry = {
    ...knownTests[idx],
    ...entry,
    location: entry.location ?? knownTests[idx].location,
  }
  if (!entry.titlePath?.length) merged.titlePath = knownTests[idx].titlePath
  knownTests[idx] = merged
  return { previousId }
}

export function knownTestLogicalKey(entry: Pick<KnownTestEntry, 'title' | 'titlePath'>): string | undefined {
  return entry.titlePath?.length ? [...entry.titlePath, entry.title].join('\u001f') : undefined
}

export function legacyTestIdForName(name: string): string {
  return `legacy-${name}`
}

export function testIdFor(input: { title: string; titlePath?: string[]; location?: string }): string {
  const parts = [
    input.location ?? '',
    ...(input.titlePath && input.titlePath.length > 0 ? input.titlePath : [input.title]),
  ]
  return `test-id-${hashString(parts.join('\u001f'))}`
}

export function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function stringAt(values: unknown[], index: number): string | undefined {
  const value = values[index]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function idForExistingResult(input: {
  name: string
  knownTests: KnownTestEntry[]
  location?: string
}): string | undefined {
  if (input.location) {
    const exact = input.knownTests.find((test) => test.name === input.name && test.location === input.location)
    if (exact && !exact.id.startsWith('legacy-')) return exact.id
  }
  const matches = input.knownTests.filter((test) => test.name === input.name)
  return matches.length === 1 && !matches[0].id.startsWith('legacy-') ? matches[0].id : undefined
}

export function readExistingSummary(): (ExistingSummary & SummaryForJournalOutcome) | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSummaryPath(), 'utf-8')) as ExistingSummary & SummaryForJournalOutcome
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
