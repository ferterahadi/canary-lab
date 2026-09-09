import path from 'path'
import { sourceRows, rowsForTest, testSelections } from '../../../../../../shared/test-source-diff'
import { extractTestMetadataFromSource, type ExtractedTest } from '../../../shared/ast-extractor'
import { getGitRoot, runGit } from '../../../shared/git-repo'
import { diffSourceText } from '../../runs/logic/dirty-specs/text-diff'

/** The current source and its markers travel together. Before-side English and
 * assessments are only needed when the reader actually opens Review. */
export async function attachSourceChanges(featureDir: string, file: string, source: string, tests: ExtractedTest[]): Promise<void> {
  const root = await getGitRoot(featureDir)
  if (!root) return
  const head = await runGit(root, ['show', `HEAD:${path.relative(root, file)}`])
  if (head.code !== 0) return
  if (head.stdout === source) {
    for (const test of tests) test.sourceChanges = { changedLines: [], count: 0 }
    return
  }
  const before = extractTestMetadataFromSource(file, head.stdout)
  const review = {
    before: { source: head.stdout, tests: before.tests },
    after: { source, tests: tests.map((test) => ({ name: test.name, line: test.line, endLine: test.endLine ?? test.line })) },
    patch: await diffSourceText(head.stdout, source, Math.max(head.stdout.split('\n').length, source.split('\n').length)),
  }
  const rows = sourceRows(review)
  const selections = testSelections(review, rows)
  for (const test of tests) {
    const selected = selections.find((item) => item.side === 'after' && item.test.line === test.line)
    const changes = rowsForTest(rows, selected, review).filter((row) => row.change != null)
    test.sourceChanges = {
      changedLines: changes.flatMap((row) => row.afterLine == null ? [] : [row.afterLine]),
      count: new Set(changes.map((row) => row.change)).size,
    }
  }
}
