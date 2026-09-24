import fs from 'fs'
import path from 'path'
import { extractTestMetadataFromSource } from '../../../shared/ast-extractor'
import { listSpecFiles } from '../../../shared/feature-loader'
import type { PlaywrightListEntry } from './playwright-list'

export const SUITE_TEST_ROSTER_FILE = '.canary-suite-tests.json'

/** Inventory source without evaluating config, envsets, or historical modules.
 * The reporter enriches this inventory; its execution selection never owns it. */
export function sourceTestRoster(dir: string): PlaywrightListEntry[] {
  return listSpecFiles(dir).flatMap((file) => {
    if (!fs.realpathSync(file).startsWith(`${fs.realpathSync(dir)}${path.sep}`)) {
      throw Object.assign(new Error('Test source is outside the suite.'), { statusCode: 409 })
    }
    const source = fs.readFileSync(file, 'utf8')
    return extractTestMetadataFromSource(file, source, { expandParametrised: true }).tests.map((test) => ({
      file, line: test.line, title: test.name, originFile: file, originLine: test.line,
      ...(test.unresolvedTitle ? { unresolvedTitle: true } : {}),
    }))
  })
}

/** Relative paths survive the reviewed-snapshot staging directory being renamed. */
export function saveSuiteTestRoster(dir: string): void {
  const tests = sourceTestRoster(dir).map((test) => ({
    ...test, file: path.relative(dir, test.file), originFile: path.relative(dir, test.originFile),
  }))
  fs.writeFileSync(path.join(dir, SUITE_TEST_ROSTER_FILE), JSON.stringify(tests))
}

export function savedSuiteTestRoster(dir: string): PlaywrightListEntry[] {
  const rosterPath = path.join(dir, SUITE_TEST_ROSTER_FILE)
  // Legacy snapshots predate the inventory, but still contain the complete source.
  if (!fs.existsSync(rosterPath)) return sourceTestRoster(dir)
  const tests: PlaywrightListEntry[] = JSON.parse(fs.readFileSync(rosterPath, 'utf8'))
  return tests.map((test) => {
    const file = path.resolve(dir, test.file)
    const originFile = path.resolve(dir, test.originFile)
    for (const candidate of [file, originFile]) {
      if (!candidate.startsWith(`${dir}${path.sep}`)
        || (fs.existsSync(candidate) && !fs.realpathSync(candidate).startsWith(`${dir}${path.sep}`))) {
        throw Object.assign(new Error('Recorded test source is outside the saved suite.'), { statusCode: 409 })
      }
    }
    return { ...test, file, originFile }
  })
}

/** Resolved runtime titles replace an unresolved source declaration at its call
 * site. Resolvable parameterised cases remain present even if only one ran. */
export function mergeSuiteTestRoster(source: PlaywrightListEntry[], recorded: PlaywrightListEntry[], locationSource: 'saved' | 'reported' = 'saved'): PlaywrightListEntry[] {
  // Repair can move a declaration between attempts. Use its saved source line
  // for display; only duplicate titles within one file need line disambiguation.
  const reportedLocations = new Map<PlaywrightListEntry, PlaywrightListEntry>()
  recorded = recorded.map((test) => {
    const matches = source.filter((definition) => definition.originFile === test.originFile && definition.title === test.title)
    const normalized = matches.length === 1 ? { ...test, line: matches[0].line, originLine: matches[0].originLine } : test
    reportedLocations.set(normalized, test)
    return normalized
  })
  const atLocation = (test: PlaywrightListEntry): string => `${test.originFile}:${test.originLine}`
  const groups = new Map<string, PlaywrightListEntry[]>()
  for (const test of source) {
    const key = atLocation(test)
    groups.set(key, [...(groups.get(key) ?? []), test])
  }
  const result: PlaywrightListEntry[] = []
  const consumed = new Set<PlaywrightListEntry>()
  for (const [key, definitions] of groups) {
    const matches = recorded.filter((test) => atLocation(test) === key)
    if (!matches.length) { result.push(...definitions); continue }
    const unresolved = definitions.every((test) => test.unresolvedTitle)
    result.push(...(unresolved ? matches : definitions.map((test) => matches.find((match) => match.title === test.title) ?? test)))
    for (const match of matches) {
      if (!unresolved && !definitions.some((test) => test.title === match.title)) result.push(match)
      consumed.add(match)
    }
  }
  // Helper-defined and legacy tests may have no recoverable source declaration.
  result.push(...recorded.filter((test) => !consumed.has(test)))
  return locationSource === 'saved' ? result : result.map((test) => reportedLocations.get(test) ?? test)
}
