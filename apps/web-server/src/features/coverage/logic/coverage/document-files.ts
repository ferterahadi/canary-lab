import fs from 'fs'
import path from 'path'

/** Generated PRD artifacts must never become summary inputs themselves. */
export const GENERATED_DOC_PREFIX = '_prd-'

export function docsDirFor(featureDir: string): string {
  return path.join(featureDir, 'docs')
}

export function isGeneratedDoc(relPath: string): boolean {
  return path.basename(relPath).startsWith(GENERATED_DOC_PREFIX)
}

export function documentCandidates(docsDir: string, options: {
  includeGenerated: boolean
  order: 'sorted' | 'filesystem'
}): string[] {
  if (!fs.existsSync(docsDir)) return []
  const names = fs.readdirSync(docsDir)
  if (options.order === 'sorted') names.sort()
  return names.filter((name) => /\.(md|markdown|txt)$/i.test(name) && (options.includeGenerated || !isGeneratedDoc(name)))
}

type DocumentInspection<T> =
  | { kind: 'file'; stat: fs.Stats; content: T }
  | { kind: 'non-file' }
  | { kind: 'unreadable' }

export function inspectDocumentFile(file: string, readContent: true): DocumentInspection<Buffer>
export function inspectDocumentFile(file: string, readContent: false): DocumentInspection<undefined>
export function inspectDocumentFile(file: string, readContent: boolean): DocumentInspection<Buffer | undefined> {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { kind: 'non-file' }
    return { kind: 'file', stat, content: readContent ? fs.readFileSync(file) : undefined }
  } catch {
    // Consumers decide whether an unavailable target is skipped, listed, or stale.
    return { kind: 'unreadable' }
  }
}
