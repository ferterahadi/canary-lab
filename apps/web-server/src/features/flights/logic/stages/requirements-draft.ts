import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { readDocsCollection, computeDocsHash } from '../../../coverage/logic/coverage/docs-collection'
import { buildPrdSummaryPrompt, readPrdSummary } from '../../../coverage/logic/coverage/prd-summary'
import { parseSummarySubmission, type SummarySubmission } from '../../../coverage/logic/coverage/external-submissions'
import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'

/** The collector can draft the summary while its source reading is still in
 * context. Canary pins it to the accepted documents; the summary stage still
 * validates and assembles it through the normal requirement-id reconciler. */
export interface RequirementsDraftInput {
  otherDocsHash: string
  previousSummary: string
}

const draftPath = (flightDir: string) => path.join(flightDir, 'docs', 'requirements-draft.json')

function previousSummary(featureDir: string): string {
  return crypto.createHash('sha256').update(JSON.stringify(readPrdSummary(featureDir) ?? null)).digest('hex')
}

export function prepareRequirementsDraft(featureDir: string, flightDir: string, outName: string): { prompt: string; input: RequirementsDraftInput } {
  fs.rmSync(draftPath(flightDir), { force: true })
  const collection = readDocsCollection(featureDir)
  const otherDocs = collection.entries.filter((entry) => entry.relPath !== outName)
  const previous = readPrdSummary(featureDir)
  return {
    prompt: buildPrdSummaryPrompt({ ...collection, entries: [...otherDocs, { relPath: outName, content: '' }] }, previous?.requirements ?? [], previous?.variantDimension),
    input: { otherDocsHash: computeDocsHash(otherDocs), previousSummary: previousSummary(featureDir) },
  }
}

export function saveRequirementsDraft(featureDir: string, flightDir: string, outName: string, input: RequirementsDraftInput | undefined, reply: string): boolean {
  if (!input) return false // Older persisted handoffs have no pinned context.
  const collection = readDocsCollection(featureDir)
  if (computeDocsHash(collection.entries.filter((entry) => entry.relPath !== outName)) !== input.otherDocsHash
    || previousSummary(featureDir) !== input.previousSummary) return false
  const answer = extractJsonCandidates(reply).map(parseSummarySubmission).find((parsed) => parsed.ok)
  if (!answer?.ok) return false
  fs.mkdirSync(path.dirname(draftPath(flightDir)), { recursive: true })
  fs.writeFileSync(draftPath(flightDir), JSON.stringify({
    docsHash: collection.docsHash,
    previousSummary: input.previousSummary,
    submission: answer.submission,
  }))
  return true
}

export function readRequirementsDraft(featureDir: string, flightDir: string): SummarySubmission | null {
  try {
    const draft = JSON.parse(fs.readFileSync(draftPath(flightDir), 'utf-8')) as { docsHash?: string; previousSummary?: string; submission?: unknown }
    if (draft.docsHash !== readDocsCollection(featureDir).docsHash || draft.previousSummary !== previousSummary(featureDir)) return null
    const parsed = parseSummarySubmission(draft.submission)
    return parsed.ok ? parsed.submission : null
  } catch {
    return null // Optional draft: fall back to the normal summary producer.
  }
}

export function clearRequirementsDraft(flightDir: string): void {
  fs.rmSync(draftPath(flightDir), { force: true })
}
