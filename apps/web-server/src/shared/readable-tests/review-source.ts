import type { ReadableSemanticRuleConfig } from '../../../../../shared/readable-tests/types'
import type { ReviewSource } from '../../../../../shared/test-review'
import { extractTestsFromSource } from '../ast-extractor'
import { translateReadableSource } from './translator'

/** One side of a before/after review: the source, its whole-file English and,
 * for a spec file, its tests. Compare test versions and a repair cycle's Code
 * changes both read a side through this, so the two cannot drift apart.
 *
 * A supporting file reads as English only when it is JavaScript or TypeScript;
 * a spec file always goes through the extractor, whose parse error then says
 * why there is no English. */
export function reviewSourceFor(
  file: string,
  source: string,
  semanticRules: ReadableSemanticRuleConfig | undefined,
  { withTests }: { withTests: boolean },
): ReviewSource {
  if (!withTests && !/\.[cm]?[jt]sx?$/.test(file)) return { source, tests: [] }
  const result = extractTestsFromSource(file, source, semanticRules)
  if (result.parseError) return { source, tests: [], parseError: result.parseError }
  const story = translateReadableSource(file, source, semanticRules)
  // `endLine` is optional on ExtractedTest only because the tests route
  // emits helper-defined entries with no AST match; every test that comes
  // out of `extractTestsFromSource` — the only producer here — carries one.
  // A `?? test.line` fallback would be an arm nothing could reach.
  const tests = withTests ? result.tests.map((test) => ({ name: test.name, line: test.line, endLine: test.endLine!, readable: test.readable })) : []
  return { source, story, tests }
}
