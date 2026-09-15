import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { diffSourceText } from '../dirty-specs/text-diff'

// Match the snapshot copier: envsets are live secrets, and symlinks are not copied.
export const SUITE_SNAPSHOT_SKIP = new Set(['envsets', 'node_modules', '.git'])

function readSuite(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (SUITE_SNAPSHOT_SKIP.has(rel)) continue
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

export async function buildSuiteReview(snapshotDir: string, liveDir: string) {
  const before = readSuite(snapshotDir)
  const after = readSuite(liveDir)
  const files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }> = []
  const patches: string[] = []
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(file)
    const current = after.get(file)
    if (old?.equals(current ?? Buffer.alloc(0)) && current !== undefined) continue
    const a = old ?? Buffer.alloc(0)
    const b = current ?? Buffer.alloc(0)
    // A text-only client cannot approve a binary change it cannot inspect.
    if ([a, b].some((bytes) => bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) {
      throw Object.assign(new Error(`Review ${file} in Canary Lab: binary suite changes need a file viewer.`), { statusCode: 409 })
    }
    files.push({ file, change: !old ? 'added' : !current ? 'deleted' : 'modified' })
    const patch = await diffSourceText(a.toString('utf8'), b.toString('utf8'), 3, false)
    const hunks = patch.slice(patch.indexOf('@@'))
    patches.push(`diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}\n--- ${old ? JSON.stringify(`a/${file}`) : '/dev/null'}\n+++ ${current ? JSON.stringify(`b/${file}`) : '/dev/null'}\n${patch ? hunks : '(empty file)\n'}`)
  }
  return { revision: revision(before, after), files, patch: patches.join('\n') }
}
