import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// Reads the source-docs collection under features/<feature>/docs/ and computes a
// stable hash over it. The hash is what drift detection compares against the
// summary's stored `docsHash`: when the source docs change, the PRD summary is
// stale and a regenerate is offered.

const DOCS_DIRNAME = 'docs'
/** Generated PRD artifacts live in docs/ too; they must NOT feed the hash or the
 *  summary input, or regeneration would chase its own tail. */
export const GENERATED_DOC_PREFIX = '_prd-'

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

export function docsDirFor(featureDir: string): string {
  return path.join(featureDir, DOCS_DIRNAME)
}

export function isGeneratedDoc(relPath: string): boolean {
  return path.basename(relPath).startsWith(GENERATED_DOC_PREFIX)
}

/**
 * Read all source docs (`*.md`, excluding generated `_prd-*`) under
 * features/<feature>/docs/. Missing docs dir → empty collection (stable hash).
 */
export function readDocsCollection(featureDir: string): DocsCollection {
  const docsDir = docsDirFor(featureDir)
  const entries: DocEntry[] = []
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).sort()) {
      if (!name.toLowerCase().endsWith('.md')) continue
      if (isGeneratedDoc(name)) continue
      const full = path.join(docsDir, name)
      if (!fs.statSync(full).isFile()) continue
      entries.push({ relPath: name, content: fs.readFileSync(full, 'utf-8') })
    }
  }
  return { docsDir, entries, docsHash: computeDocsHash(entries) }
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
