import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { z } from 'zod'

const sourceInput = z.object({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 of the source bytes you read.'),
  reason: z.string().trim().min(1).max(1000).describe('Which requirements match the task and why this source applies.'),
})
const searched = z.array(z.string().trim().min(1).max(4096)).min(1).max(20)
const unresolved = {
  searched,
  question: z.string().trim().min(1).max(2000),
  candidates: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    sources: z.array(sourceInput).min(1).max(10),
  })).min(1).max(5),
}

export const documentResolutionInput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), searched, sources: z.array(sourceInput).min(1).max(10) }),
  z.object({ status: z.literal('missing'), searched, reason: z.string().trim().min(1).max(2000) }),
  z.object({ status: z.literal('ambiguous'), ...unresolved }),
  z.object({ status: z.literal('conflicting'), ...unresolved, candidates: unresolved.candidates.min(2) }),
]).refine((value) => JSON.stringify(value).length <= 8000, 'Keep discovery evidence and candidate choices under 8 KB; provide paths, not document contents.')
export type DocumentResolution = z.infer<typeof documentResolutionInput>
export type DocumentSource = z.infer<typeof sourceInput>

const selectionInput = z.object({
  reviewedDocsHash: z.string(),
  decisionKey: z.string(),
  intent: z.string().optional(),
  sources: z.array(sourceInput.extend({ relPath: z.string() })),
  excluded: z.array(z.object({ relPath: z.string(), sha256: z.string() })),
  searched: z.array(z.string()),
})
export type DocumentSelection = z.infer<typeof selectionInput>
const selectionPath = (featureDir: string) => path.join(featureDir, 'docs', '_document-selection.json')

export function documentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function readDocumentSelection(featureDir: string): DocumentSelection | null {
  try {
    const parsed = selectionInput.safeParse(JSON.parse(fs.readFileSync(selectionPath(featureDir), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null // Older features have no source selection receipt.
  }
}

export function writeDocumentSelection(featureDir: string, selection: DocumentSelection): void {
  const dest = selectionPath(featureDir)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(`${dest}.tmp`, JSON.stringify(selection, null, 2) + '\n')
  fs.renameSync(`${dest}.tmp`, dest)
}
