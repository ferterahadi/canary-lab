import path from 'node:path'
import { localSourceHelper, suiteHelperResolver } from './suite-helpers'
import type { ReadableSemanticRuleConfig } from '../../../../../shared/readable-tests/types'
import type { ReviewSource } from '../../../../../shared/test-review'
import { extractTestsFromSource } from '../ast-extractor'
import { reviewStories } from './translator'

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
  { withTests, side, suiteRoot }: { withTests: boolean; side?: 'before' | 'after'; suiteRoot?: string },
): ReviewSource {
  if (!withTests && !/\.[cm]?[jt]sx?$/.test(file)) return { source, tests: [] }
  // Resolve imports only when the caller owns this revision's complete suite.
  // Reconstructed blobs and Git snapshots can still resolve same-file symbols.
  const pathForRevision = suiteRoot ? path.join(suiteRoot, file) : file
  const resolveHelper = suiteRoot ? suiteHelperResolver(suiteRoot) : localSourceHelper
  const result = extractTestsFromSource(pathForRevision, source, semanticRules, resolveHelper, side && { kind: side })
  if (result.parseError) return { source, tests: [], parseError: result.parseError }
  const { story, outline, fileFlow } = reviewStories(file, source, semanticRules, side && { side, resolveHelper, moduleFile: pathForRevision })
  // `endLine` is optional on ExtractedTest only because the tests route
  // emits helper-defined entries with no AST match; every test that comes
  // out of `extractTestsFromSource` — the only producer here — carries one.
  // A `?? test.line` fallback would be an arm nothing could reach.
  const tests = withTests ? result.tests.map((test) => ({ name: test.name, line: test.line, endLine: test.endLine!, readable: test.readable })) : []
  if (suiteRoot) {
    for (const readable of [fileFlow, ...tests.map(t => t.readable)]) {
      for (const def of readable?.navigation?.definitions ?? []) {
        def.suiteFile = path.isAbsolute(def.source.file) ? path.relative(suiteRoot, def.source.file).split(path.sep).join('/') : def.source.file
      }
    }
  }
  return { source, story, outline, tests, fileFlow }
}
