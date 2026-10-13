import { docsDirFor, documentCandidates, inspectDocumentFile } from './document-files'
import path from 'path'
import crypto from 'crypto'
import { documentHash, readDocumentSelection } from './document-resolution'

// Reads the source-docs collection under features/<feature>/docs/ and computes a
// stable hash over it. The hash is what drift detection compares against the
// summary's stored `docsHash`: when the source docs change, the PRD summary is
// stale and a regenerate is offered.

export interface DocEntry {
  /** Path relative to docs/, e.g. "spec.md". */
  relPath: string
  content: string
}

export interface DocsCollection {
  docsDir: string
  /** Source docs only (generated `_prd-*` excluded), sorted by relPath. */
  entries: DocEntry[]
  docsHash: string
}

/**
 * Read all source docs (`*.md`/`*.markdown`/`*.txt`, excluding generated
 * `_prd-*`) under features/<feature>/docs/. Missing docs dir → empty
 * collection (stable hash). Symlinked docs are read through the link (the
 * user's original is the live source); a dangling symlink is skipped — it
 * must not crash the PRD summary, the docs rail lists it as broken instead.
 */
export function readDocsCollection(featureDir: string, options?: { includeExcluded: boolean }): DocsCollection {
  const docsDir = docsDirFor(featureDir)
  const entries: DocEntry[] = []
  for (const name of documentCandidates(docsDir, { includeGenerated: false, order: 'sorted' })) {
    const result = inspectDocumentFile(path.join(docsDir, name), true)
    if (result.kind === 'file') entries.push({ relPath: name, content: result.content.toString('utf-8') })
  }
  // Keep rejected originals available in the Docs rail, but do not feed them
  // back into the summary after a source choice. An edited original is new
  // evidence: its old exclusion expires and ordinary drift detection sees it.
  const excluded = options?.includeExcluded ? [] : readDocumentSelection(featureDir)?.excluded ?? []
  const selected = entries.filter((entry) => !excluded.some((item) => item.relPath === entry.relPath && item.sha256 === documentHash(entry.content)))
  return { docsDir, entries: selected, docsHash: computeDocsHash(selected) }
}

/**
 * Stable SHA-256 over sorted (relPath, content) pairs. Order-independent of
 * filesystem enumeration: re-ordering the directory listing or re-reading the
 * same files yields the same hash; changing any path or byte changes it.
 */
export function computeDocsHash(entries: DocEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath))
  const hash = crypto.createHash('sha256')
  for (const entry of sorted) {
    hash.update(entry.relPath)
    hash.update('\0')
    hash.update(entry.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}
