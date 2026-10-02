import { createHash } from 'crypto'

function digest(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort()) {
    hash.update(JSON.stringify([name, createHash('sha256').update(files.get(name)!).digest('hex')]))
  }
  return hash.digest('hex')
}

/** Persisted approvals bind to this exact encoding, including unchanged files. */
export function reviewRevision(before: ReadonlyMap<string, Buffer>, after: ReadonlyMap<string, Buffer>): string {
  return createHash('sha256').update(`${digest(before)}:${digest(after)}`).digest('hex')
}

export function compareReviewFiles(
  before: ReadonlyMap<string, Buffer>,
  after: ReadonlyMap<string, Buffer>,
  paths: Iterable<string> = [...before.keys(), ...after.keys()],
) {
  const files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }> = []
  // Git review can disclose a path absent from both maps. Keep that requested
  // path in its comparison even though it contributes no bytes to the revision.
  for (const file of [...new Set(paths)].sort()) {
    const old = before.get(file)
    const current = after.get(file)
    if (old?.equals(current ?? Buffer.alloc(0)) && current !== undefined) continue
    files.push({ file, change: !old ? 'added' : !current ? 'deleted' : 'modified' })
  }
  return { revision: reviewRevision(before, after), files }
}
