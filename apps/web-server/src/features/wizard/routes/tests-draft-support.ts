import fs from 'fs'
import path from 'path'
import { writeDraft, paths as draftPaths, readDraft, slugifyFeatureName, transition, type DraftRecord, type DraftPrdDocument } from '../logic/draft-store'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import type { TestsDraftRouteDeps } from './tests-draft'

export function isTransientGenerationStatus(status: DraftRecord['status']): boolean {
  return status === 'planning' || status === 'generating'
}

export function isCancelled(logsDir: string, draftId: string): boolean {
  return readDraft(logsDir, draftId)?.status === 'cancelled'
}

export function isStageCurrent(logsDir: string, draftId: string, status: DraftRecord['status']): boolean {
  return readDraft(logsDir, draftId)?.status === status
}

export function transitionDraft(
  deps: TestsDraftRouteDeps,
  draftId: string,
  status: DraftRecord['status'],
  patch?: Partial<DraftRecord>,
): DraftRecord {
  const next = transition(deps.logsDir, draftId, status, patch)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
  return next
}

export function patchDraft(deps: TestsDraftRouteDeps, draftId: string, patch: Partial<DraftRecord>): void {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  const next = { ...rec, ...patch }
  writeDraft(deps.logsDir, next)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
}

export function isDraftPrdDocument(value: unknown): value is DraftPrdDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<DraftPrdDocument>
  return typeof doc.filename === 'string'
    && typeof doc.contentType === 'string'
    && typeof doc.characters === 'number'
    && (doc.text === undefined || typeof doc.text === 'string')
    && (doc.contentBase64 === undefined || typeof doc.contentBase64 === 'string')
}

export function additionalNotesDocForDraft(rec: DraftRecord): { path: string; content: string }[] {
  const notes = rec.additionalNotes?.trim()
  return notes
    ? [{
        path: 'docs/additional-notes.md',
        content: `# Additional notes\n\n${notes}\n`,
      }]
    : []
}

export function intentSummaryDocForDraft(rec: DraftRecord): { path: string; content: string }[] {
  const summary = rec.intentSummary?.trim()
  return summary
    ? [{
        path: 'docs/intent.md',
        content: `# Intent summary\n\n${summary}\n`,
      }]
    : []
}

export function writeUploadedDocumentCopies(featureDir: string, rec: DraftRecord): string[] {
  const written: string[] = []
  const used = new Set<string>()
  rec.prdDocuments.forEach((doc) => {
    if (!doc.contentBase64) return
    const filename = uniqueUploadedFilename(featureDir, doc.filename, used)
    const target = path.join(featureDir, 'docs', filename)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(doc.contentBase64, 'base64'))
    written.push(target)
  })
  return written
}

export function uniqueUploadedFilename(featureDir: string, filename: string, used: Set<string>): string {
  const safe = safeUploadedFilename(filename)
  const parsed = path.parse(safe)
  let candidate = safe
  let suffix = 2
  while (
    used.has(candidate.toLowerCase())
    || fs.existsSync(path.join(featureDir, 'docs', candidate))
  ) {
    candidate = `${parsed.name}-${suffix}${parsed.ext}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function safeUploadedFilename(filename: string): string {
  const base = filename.replace(/[\\/]+/g, '-').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!base || base === '.' || base === '..') return 'document'
  return base
}

export function defaultFeatureName(rec: DraftRecord): string {
  const fromPrd = slugifyFeatureName(rec.prdText)
  if (fromPrd !== 'untitled-feature') return fromPrd
  const firstRepo = rec.repos[0]
  if (!firstRepo) return fromPrd
  return slugifyFeatureName(`${firstRepo.name} e2e tests`)
}

export function readGeneratedFiles(logsDir: string, draftId: string): { path: string; content: string }[] {
  const p = draftPaths(logsDir, draftId)
  if (!fs.existsSync(p.generatedDir)) return []
  return walk(p.generatedDir, p.generatedDir)
}

export function walk(root: string, dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(root, full))
    } else if (entry.isFile()) {
      out.push({
        path: path.relative(root, full),
        content: fs.readFileSync(full, 'utf8'),
      })
    }
  }
  return out
}
