import fs from 'fs'
import path from 'path'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { findFeature, isWithin, linkFeatureDoc } from '../features/config/logic/feature-authoring'
import { readDocsCollection } from '../features/coverage/logic/coverage/docs-collection'
import { documentHash, documentResolutionInput, readDocumentSelection, writeDocumentSelection, type DocumentSource } from '../features/coverage/logic/coverage/document-resolution'
import { resolveRepoPath } from '../shared/git-repo'
import { renderPrompt } from '../shared/prompts'
import { publishWorkspaceEvent } from '../shared/workspace-events'
import { elicitationAdviceFor } from './client-surface'
import { requestDocuments } from './document-input'
import { requestBrokenDocumentPath } from './document-relink'
import { inputFingerprint, inputPending, requestUserInput, resumeUrlInput } from './elicitation'
import { asJsonResult, authoringCtx, errorResult, type ToolGroupContext } from './tool-support'

export { documentResolutionInput }
type Result = CallToolResult | InputRequiredResult

// Resolve directory aliases (for example macOS /var → /private/var) while
// retaining a document symlink's name inside the authorized docs directory.
const documentPath = (file: string) => path.join(fs.realpathSync(path.dirname(file)), path.basename(file))

interface ResolveDocumentsOptions {
  ctx: ToolGroupContext
  request: ServerContext | undefined
  feature: string
  scope: unknown
  resolution?: unknown
  documentSource?: 'form' | 'upload'
  command: string
  repoPaths?: string[]
  intent?: string
  revision?: unknown
  beforeWrite?: () => CallToolResult | undefined | Promise<CallToolResult | undefined>
  /** Continue the caller's work now that `featureDir`'s sources are settled.
   *  The directory is handed over because this gate has already proven the
   *  feature exists — a second lookup in the caller could only fail. */
  ready: (featureDir: string) => Promise<Result>
}

/** Semantic judgment belongs to the calling agent. This gate checks its source
 * evidence and reuses the same document writers and MCP 2.0 input handler for
 * coverage and flights; it never launches another model to judge relevance. */
export async function resolveDocuments(options: ResolveDocumentsOptions): Promise<Result> {
  const { ctx, request, feature, scope, ready, command } = options
  const resumed = resumeUrlInput(request, ctx.clientFacts(), scope)
  if (resumed) return resumed
  const found = findFeature(ctx.deps.featuresDir, feature)
  if (!found?.featureDir) return errorResult(`feature not found: ${feature}`)
  const featureDir = found.featureDir
  const relink = await requestBrokenDocumentPath({ ...options, featureDir })
  if (relink) return relink
  const collection = readDocsCollection(featureDir, { includeExcluded: true })
  const roots = (options.repoPaths ?? found.repos?.map((repo) => repo.localPath) ?? []).map((repo) => path.resolve(ctx.deps.projectRoot, resolveRepoPath(repo)))
  const discovery = (reason?: string) => asJsonResult({
    status: 'needs-document-discovery', feature, ...(reason ? { reason } : {}),
    repoPaths: roots,
    docs: collection.entries.slice(0, 20).map((entry) => ({ path: path.join(collection.docsDir, entry.relPath), sha256: documentHash(entry.content) })),
    sourceDocCount: collection.entries.length,
    next: renderPrompt('document-discovery.md', { feature, intent: options.intent ?? found.description ?? feature, command }),
  })
  const parsed = options.resolution === undefined ? undefined : documentResolutionInput.safeParse(options.resolution)
  if (parsed && !parsed.success) return errorResult('Invalid document_resolution. Supply the completed search and source evidence, or the specific unresolved issue.')
  const resolution = parsed?.data
  const replay = request?.mcpReq.requestState?.() !== undefined
  const selection = readDocumentSelection(featureDir)
  const decisionKey = inputFingerprint(resolution)
  const use = async (sources: DocumentSource[], expectedDocsHash = collection.docsHash): Promise<Result> => {
    const check = options.beforeWrite?.()
    const blocked = check instanceof Promise ? await check : check
    if (blocked) return blocked
    if (inputFingerprint(readDocumentSelection(featureDir)) !== inputFingerprint(selection)
      || readDocsCollection(featureDir, { includeExcluded: true }).docsHash !== expectedDocsHash) return inputPending('The documents or their source selection changed before this answer was applied. Review the current documents.')
    // Validate every file before the first import. Re-check on acceptance too:
    // a selected source may have changed while its form was open.
    const problem = validate(sources)
    if (problem) return inputPending(problem)
    const currentDocs = readDocsCollection(featureDir, { includeExcluded: true })
    const accepted: Array<DocumentSource & { relPath: string }> = []
    for (const source of sources) {
      const imported = currentDocs.entries.find((entry) => documentPath(path.join(collection.docsDir, entry.relPath)) === documentPath(source.path))
      const relPath = imported?.relPath ?? `source-${inputFingerprint(source.path).slice(0, 12)}${path.extname(source.path).toLowerCase()}`
      if (!imported) {
        const linked = linkFeatureDoc(authoringCtx(ctx.deps), { feature, targetPath: source.path, relPath })
        if (!linked.ok) return errorResult(linked.error)
      }
      accepted.push({ ...source, relPath })
    }
    const all = readDocsCollection(featureDir, { includeExcluded: true })
    writeDocumentSelection(featureDir, {
      reviewedDocsHash: all.docsHash, decisionKey,
      intent: options.intent ?? found.description ?? feature,
      sources: accepted, searched: resolution?.searched ?? ['User supplied documents'],
      excluded: all.entries.filter((entry) => !accepted.some((source) => source.relPath === entry.relPath))
        .map((entry) => ({ relPath: entry.relPath, sha256: documentHash(entry.content) })),
    })
    publishWorkspaceEvent(ctx.deps.workspaceEvents, { type: 'coverage-changed', feature })
    return ready(featureDir)
  }
  function validate(sources: DocumentSource[]): string | undefined {
    for (const source of sources) {
      try {
        const real = fs.realpathSync(source.path)
        const imported = readDocsCollection(featureDir, { includeExcluded: true }).entries.some((entry) => documentPath(path.join(collection.docsDir, entry.relPath)) === documentPath(source.path))
        const authorized = imported || roots.some((root) => {
          try { return isWithin(fs.realpathSync(root), real) } catch { return false /* unavailable repo */ }
        })
        if (!path.isAbsolute(source.path) || !authorized) return `Source is outside this feature's authorized repositories/documents: ${source.path}. Link an explicit user-provided reference with write_feature_doc first.`
        const stat = fs.statSync(real)
        if (!stat.isFile() || !/\.(md|markdown|txt)$/i.test(real) || path.basename(real).startsWith('_') || stat.size > 2 * 1024 * 1024) return `Not a supported source document: ${source.path}`
        if (documentHash(fs.readFileSync(real)) !== source.sha256) return `Document changed since discovery: ${source.path}. Read it again before resolving sources.`
      } catch {
        return `Document is unavailable: ${source.path}. Revisit discovery before resolving sources.`
      }
    }
  }
  const supplied = async (paths: string[]): Promise<Result> => {
    const suppliedHash = readDocsCollection(featureDir, { includeExcluded: true }).docsHash
    if (resolution?.status === 'ambiguous' || resolution?.status === 'conflicting') {
      return use(paths.map((file) => ({ path: file, sha256: documentHash(fs.readFileSync(file)), reason: 'User supplied replacement requirements for the unresolved source choice.' })), suppliedHash)
    }
    const current = readDocsCollection(featureDir)
    return use(current.entries.map((entry) => ({ path: path.join(current.docsDir, entry.relPath), sha256: documentHash(entry.content), reason: 'User supplied requirements, together with the existing active sources.' })), suppliedHash)
  }
  const askForDocs = () => requestDocuments(ctx, request, feature, scope, options.documentSource === 'upload',
    () => asJsonResult({ status: 'needs-docs', feature, reason: resolution?.status === 'missing' ? resolution.reason : 'Requirements needed',
      next: `${elicitationAdviceFor(ctx.clientFacts(), 'form')} ASK THE USER for the missing requirements, then write_feature_doc and retry ${command}. Never invent a document.` }), supplied,
    { revision: [options.revision, collection.docsHash, selection, resolution], beforeWrite: options.beforeWrite,
      message: resolution?.status === 'missing' ? `Requirements for ${feature} are missing: ${resolution.reason}` : undefined,
      command })
  if (replay && !options.documentSource && (!resolution || resolution.status === 'resolved')) return inputPending('This discovery outcome has no elicitation to resume. Nothing was applied.')
  if (!replay && resolution?.status === 'missing' && selection?.decisionKey === decisionKey && selection.reviewedDocsHash === collection.docsHash) return ready(featureDir)
  if (options.documentSource) return askForDocs()
  if (!resolution) {
    if (selection && selection.reviewedDocsHash !== collection.docsHash) return discovery('The reviewed document set changed. Reassess its relevance and conflicts.')
    return selection && readDocsCollection(featureDir).entries.length > 0 ? ready(featureDir) : discovery()
  }
  if (resolution.status === 'missing') return askForDocs()
  const sources = resolution.status === 'resolved' ? resolution.sources : resolution.candidates.flatMap((candidate) => candidate.sources)
  const problem = validate(sources)
  if (problem) return replay ? inputPending(problem) : discovery(problem)
  if (!replay && selection?.decisionKey === decisionKey && selection.reviewedDocsHash === collection.docsHash) return ready(featureDir)
  if (resolution.status === 'resolved') return use(sources)
  const choices = resolution.candidates.map((candidate, i) => `${i + 1}: ${candidate.label}`)
  const schema = z.object({ choice: z.enum([choices[0], ...choices.slice(1), 'Provide requirements', 'Upload documents']) })
  const message = `${resolution.question}\n${resolution.candidates.map((candidate, i) => `${choices[i]}\n${candidate.sources.map((source) => `${source.path}: ${source.reason}`).join('\n')}`).join('\n')}`
  const facts = ctx.clientFacts()
  return requestUserInput(request, facts, {
    scope, revision: [options.revision, collection.docsHash, selection, resolution], mode: 'form', schema, message,
    fallback: () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', feature, question: message,
      next: `${elicitationAdviceFor(facts, 'form')} ASK THE USER this source question. Return their selected sources as document_resolution.status:"resolved" on ${command}; do not choose for them.` }),
  }, async (answer) => {
    const index = choices.indexOf(answer.choice)
    if (index >= 0) return use(resolution.candidates[index].sources)
    return asJsonResult({ status: 'needs-docs', feature,
      next: `The user chose to supply documents. Call ${command} with the same document_resolution and document_source:"${answer.choice === 'Upload documents' ? 'upload' : 'form'}". Do not repeat the source question.` })
  })
}
