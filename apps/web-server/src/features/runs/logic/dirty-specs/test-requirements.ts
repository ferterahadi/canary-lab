// The `@requirement` ids a live spec's tests carry, by test name. One reader for the
// two surfaces that attach a requirement to a strength verdict — the run's
// integrity hints and the feature list's dirty summary — so both read the tags
// from the same live source with syntax-only annotation parsing. Requirement
// lookups must not translate every test and block a source-edit refresh.
import { extractTestMetadataFromSource } from '../../../../shared/ast-extractor'

export type TestRequirements = Map<string, string[] | undefined>

/** Reads the source once, and only when a caller asks for a test — a spec that
 *  produces no hint is never parsed. `undefined` for a test the live file does
 *  not declare (deleted since the copy was taken) or one with no tags. */
export function testRequirementsReader(
  rel: string,
  readLiveSource: (rel: string) => string | undefined,
): (test: string) => string[] | undefined {
  let byName: TestRequirements | null = null
  return (test) => {
    if (!byName) {
      const source = readLiveSource(rel)
      byName = source === undefined ? new Map() : testRequirementsOf(rel, source)
    }
    return byName.get(test)
  }
}

export function testRequirementsOf(rel: string, source: string): TestRequirements {
  return new Map(extractTestMetadataFromSource(rel, source).tests.map((t) => [t.name, t.requirements]))
}
