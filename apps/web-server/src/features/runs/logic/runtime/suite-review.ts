import fs from 'fs'
import path from 'path'
import { COVERAGE_STATE_JSON } from '../../../coverage/logic/coverage/run-state'
import { diffSourceText } from '../dirty-specs/text-diff'
import { SUITE_TEST_ROSTER_FILE } from '../suite-test-roster'
import { compareReviewFiles, reviewRevision } from '../test-review-comparison'

// Match the snapshot copier: envsets and the runtime files it materializes are
// live secrets, and symlinks are not copied. Coverage state is engine-owned
// verification metadata, not authored test input or something a human should
// review, restore, or adopt.
export const SUITE_SNAPSHOT_SKIP = new Set(['envsets', 'node_modules', '.git', SUITE_TEST_ROSTER_FILE, `docs/${COVERAGE_STATE_JSON}`])

export function skipSuiteSnapshotPath(relativePath: string): boolean {
  return SUITE_SNAPSHOT_SKIP.has(relativePath) || relativePath === '.env' || /^\.env\.bak\.\d+$/.test(relativePath)
}

function readSuite(root: string, excludedPaths: Iterable<string> = []): Map<string, Buffer> {
  const excluded = new Set([...excludedPaths].map((file) => file.split(path.sep).join('/')))
  const files = new Map<string, Buffer>()
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (skipSuiteSnapshotPath(rel) || excluded.has(rel)) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file, rel)
      else if (entry.isFile()) files.set(rel, fs.readFileSync(file))
    }
  }
  visit(root, '')
  return files
}

/** Covers every reviewable copied byte, including helpers/config and unchanged
 * specs. Engine-owned runtime metadata follows the snapshot skip contract. */
export function suiteReviewRevision(snapshotDir: string, liveDir: string, excludedPaths: Iterable<string> = []): string {
  return reviewRevision(readSuite(snapshotDir, excludedPaths), readSuite(liveDir, excludedPaths))
}

function executionInputs(files: ReadonlyMap<string, Buffer>): Map<string, Buffer> {
  return new Map([...files].filter(([file]) =>
    !file.startsWith('docs/') && file !== 'feature.config.cjs' &&
    (file.startsWith('e2e/') || /\.(?:[cm]?[jt]sx?|json)$/.test(file)),
  ))
}

/** Runtime env files and generated documentation change during a run. The
 * fresh-start gate watches test inputs, while human adoption still reviews
 * the complete copied suite. */
export function suiteExecutionRevision(snapshotDir: string, liveDir: string, excludedPaths: Iterable<string> = []): string {
  return reviewRevision(executionInputs(readSuite(snapshotDir, excludedPaths)), executionInputs(readSuite(liveDir, excludedPaths)))
}

/** Reuse bytes only within one gate evaluation. Acceptance and copying still
 * take fresh inventories at their existing revalidation boundaries. */
export function suiteReviewAssessment(snapshotDir: string, liveDir: string, excludedPaths: Iterable<string> = []) {
  const { before, after, revision, files } = suiteReviewFiles(snapshotDir, liveDir, excludedPaths)
  const recordedInputs = executionInputs(before)
  const currentInputs = executionInputs(after)
  return {
    revision, files,
    executionChanged: reviewRevision(recordedInputs, currentInputs) !== reviewRevision(recordedInputs, recordedInputs),
  }
}

export async function buildSuiteReview(snapshotDir: string, liveDir: string, excludedPaths: Iterable<string> = []) {
  const { before, after, files, revision: reviewedRevision } = suiteReviewFiles(snapshotDir, liveDir, excludedPaths)
  const patches: string[] = []
  for (const { file } of files) {
    const old = before.get(file)
    const current = after.get(file)
    const a = old ?? Buffer.alloc(0)
    const b = current ?? Buffer.alloc(0)
    // A text-only client cannot approve a binary change it cannot inspect.
    if ([a, b].some((bytes) => bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) {
      throw Object.assign(new Error(`Review ${file} in Canary Lab: binary suite changes need a file viewer.`), { statusCode: 409 })
    }
    const patch = await diffSourceText(a.toString('utf8'), b.toString('utf8'), 3, false)
    const hunks = patch.slice(patch.indexOf('@@'))
    patches.push(`diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n--- ${old ? JSON.stringify(`a/${file}`) : '/dev/null'}\n+++ ${current ? JSON.stringify(`b/${file}`) : '/dev/null'}\n${patch ? hunks : '(empty file)\n'}`)
  }
  return { revision: reviewedRevision, files, patch: patches.join('\n') }
}

/** One inventory for approval, restoration and the human comparison viewer. */
export function suiteReviewFiles(snapshotDir: string, liveDir: string, excludedPaths: Iterable<string> = []) {
  const before = readSuite(snapshotDir, excludedPaths)
  const after = readSuite(liveDir, excludedPaths)
  return { ...compareReviewFiles(before, after), before, after }
}
