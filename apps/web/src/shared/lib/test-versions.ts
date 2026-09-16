import type { FeatureSpecFile } from '../api/types'

export interface RunDifference {
  file: string
  affectedTests: string[]
}

export interface VersionTest {
  file: string
  name: string
  line: number
}

export function suiteRelativeFile(file: string, ...roots: Array<string | undefined>): string {
  for (const root of roots) {
    if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1)
  }
  return file
}

/** Match declarations, not results or line numbers: moving a test does not add it.
 * Duplicate titles retain their multiplicity instead of collapsing into a set. */
export function compareTestVersions(current: FeatureSpecFile[], recorded: FeatureSpecFile[], roots: Array<string | undefined>, differences: RunDifference[]) {
  const entries = (specs: FeatureSpecFile[]): VersionTest[] => specs.flatMap((spec) => spec.tests.map((test) => ({
    file: suiteRelativeFile(spec.file, ...roots), name: test.name, line: test.line,
  })))
  const remaining = new Map<string, VersionTest[]>()
  const keyFor = (test: VersionTest) => JSON.stringify([test.file, test.name])
  for (const test of entries(recorded)) {
    const key = keyFor(test)
    remaining.set(key, [...(remaining.get(key) ?? []), test])
  }
  const added: VersionTest[] = []
  const changed: VersionTest[] = []
  for (const test of entries(current)) {
    const matches = remaining.get(keyFor(test))
    if (!matches?.length) added.push(test)
    else {
      matches.shift()
      if (differences.some((diff) => diff.file === test.file && diff.affectedTests.includes(test.name))) changed.push(test)
    }
  }
  return { added, changed, removed: [...remaining.values()].flat() }
}
