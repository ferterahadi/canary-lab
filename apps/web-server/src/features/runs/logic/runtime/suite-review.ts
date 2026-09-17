import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { diffSourceText } from '../dirty-specs/text-diff'
import { SUITE_TEST_ROSTER_FILE } from '../suite-test-roster'

// Match the snapshot copier: envsets and the runtime files it materializes are
// live secrets, and symlinks are not copied. A crashed/restarted run can leave
// the target or one of env-switcher's timestamped backups beside the suite;
// neither is authored test input or something a human should Adopt.
export const SUITE_SNAPSHOT_SKIP = new Set(['envsets', 'node_modules', '.git', SUITE_TEST_ROSTER_FILE])

export function skipSuiteSnapshotPath(relativePath: string): boolean {
  return SUITE_SNAPSHOT_SKIP.has(relativePath) || relativePath === '.env' || /^\.env\.bak\.\d+$/.test(relativePath)
}

function readSuite(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (skipSuiteSnapshotPath(rel)) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file, rel)
      else if (entry.isFile()) files.set(rel, fs.readFileSync(file))
    }
  }
  visit(root, '')
  return files
}

function digest(files: Map<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort()) {
    hash.update(JSON.stringify([name, createHash('sha256').update(files.get(name)!).digest('hex')]))
  }
  return hash.digest('hex')
}

function revision(before: Map<string, Buffer>, after: Map<string, Buffer>): string {
  return createHash('sha256').update(`${digest(before)}:${digest(after)}`).digest('hex')
}

/** Covers every copied byte, including helpers/config and unchanged specs. */
export function suiteReviewRevision(snapshotDir: string, liveDir: string): string {
  return revision(readSuite(snapshotDir), readSuite(liveDir))
}

/** Runtime env files and generated documentation change during a run. The
 * fresh-start gate watches test inputs, while human adoption still reviews
 * the complete copied suite. */
export function suiteExecutionRevision(snapshotDir: string, liveDir: string): string {
  const inputs = (dir: string) => new Map([...readSuite(dir)].filter(([file]) =>
    !file.startsWith('docs/') && file !== 'feature.config.cjs' &&
    (file.startsWith('e2e/') || /\.(?:[cm]?[jt]sx?|json)$/.test(file)),
  ))
  return revision(inputs(snapshotDir), inputs(liveDir))
}

export async function buildSuiteReview(snapshotDir: string, liveDir: string) {
  const { before, after, files, revision: reviewedRevision } = suiteReviewFiles(snapshotDir, liveDir)
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
export function suiteReviewFiles(snapshotDir: string, liveDir: string) {
  const before = readSuite(snapshotDir)
  const after = readSuite(liveDir)
  const files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }> = []
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(file)
    const current = after.get(file)
    if (old?.equals(current ?? Buffer.alloc(0)) && current !== undefined) continue
    files.push({ file, change: !old ? 'added' : !current ? 'deleted' : 'modified' })
  }
  return { revision: revision(before, after), files, before, after }
}
