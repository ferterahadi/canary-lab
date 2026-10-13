import { formatCodeForDisplayWithLineMap, type FormattedCodeDisplay } from '../../../../../shared/code-display-format'
import type { ExtractedTest } from '../../../../../shared/extracted-test'

/** Attaches each test's Code-mode listing, formatting a body once however many
 * tests share it. The Tests column and the evaluation report both number code
 * rows from this listing, so the two read the same rows. */
export function codeDisplayAttacher(): (test: ExtractedTest) => ExtractedTest {
  const cache = new Map<string, FormattedCodeDisplay>()
  return (test) => {
    if (!test.bodySource) return test
    const sourceStartLine = test.bodyLine ?? test.line
    const key = `${sourceStartLine}\0${test.bodySource}`
    let codeDisplay = cache.get(key)
    if (!codeDisplay) {
      codeDisplay = formatCodeForDisplayWithLineMap(test.bodySource, sourceStartLine)
      cache.set(key, codeDisplay)
    }
    return { ...test, codeDisplay }
  }
}
