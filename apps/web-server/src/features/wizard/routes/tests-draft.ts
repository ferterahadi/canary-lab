import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { applyToProject, mergeRootDevDependencies, createDraft, deleteDraft, listDrafts, paths as draftPaths, readDraft, validateFeatureTarget, type DraftPrdDocument, type DraftRepo } from '../logic/draft-store'
import {
  buildAgentSessionResponse,
} from '../../agent-sessions/logic/agent-session-log'
import { resolveDraftStageSessionRef } from '../logic/draft-agent-session'
import { validateGeneratedFeatureFiles } from '../../../../../../shared/feature-scaffold'
import { resolveDraftFile } from '../logic/draft-file-resolver'
import { combinePrdText, extractPrdDocument } from '../../coverage/logic/prd-document-extractor'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { PlanAgentInput, SpecAgentInput, runPlanStage, runSpecStage, tailIfExists } from './tests-draft-stages'
import { additionalNotesDocForDraft, defaultFeatureName, intentSummaryDocForDraft, isDraftPrdDocument, isTransientGenerationStatus, readGeneratedFiles, transitionDraft, writeUploadedDocumentCopies } from './tests-draft-support'

export { hasUserContext, selectPlanTemplate } from './tests-draft-stages'
export type { PlanAgentInput, PlanMode, SpecAgentInput } from './tests-draft-stages'

export interface TestsDraftRouteDeps {
  logsDir: string
  projectRoot: string
  newDraftId(): string
  pickAgent?(): { ok: true; agent: 'claude' | 'codex' } | { ok: false; error: string }
  spawnPlanAgent(input: PlanAgentInput): Promise<string>
  spawnSpecAgent(input: SpecAgentInput): Promise<string>
  cancelGeneration?(draftId: string): boolean
  workspaceEvents?: WorkspaceEventPublisher
}

export async function testsDraftRoutes(
  app: FastifyInstance,
  deps: TestsDraftRouteDeps,
): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 20,
    },
  })

  app.post('/api/tests/prd-documents', async (req, reply) => {
    if (!req.isMultipart()) {
      reply.code(400)
      return { error: 'multipart form data required' }
    }
    const documents = []
    let pastedText = ''
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'prdText' && typeof part.value === 'string') {
            pastedText = part.value
          }
          continue
        }
        const buffer = await part.toBuffer()
        const extracted = await extractPrdDocument({
          filename: part.filename,
          contentType: part.mimetype,
          buffer,
        })
        documents.push({
          ...extracted,
          contentBase64: buffer.toString('base64'),
        })
      }
    } catch (err) {
      reply.code(400)
      return { error: (err as Error).message }
    }
    const prdText = combinePrdText({ pastedText, documents })
    if (!prdText) {
      reply.code(400)
      return { error: 'PRD text required' }
    }
    return {
      prdText,
      documents: documents.map((doc): DraftPrdDocument => ({
        filename: doc.filename,
        contentType: doc.contentType,
        characters: doc.characters,
        text: doc.text,
        contentBase64: doc.contentBase64,
      })),
    }
  })

  app.post<{
    Body: { prdText?: unknown; additionalNotes?: unknown; prdDocuments?: unknown; repos?: unknown; featureName?: unknown }
  }>('/api/tests/draft', async (req, reply) => {
    const prdText = req.body?.prdText
    const additionalNotes = req.body?.additionalNotes
    const prdDocuments = req.body?.prdDocuments
    const repos = req.body?.repos
    const featureName = req.body?.featureName
    if (typeof prdText !== 'string') {
      reply.code(400)
      return { error: 'prdText must be a string' }
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      reply.code(400)
      return { error: 'repos[] required' }
    }
    const repoList = repos.map((r) => r as DraftRepo)
    const documentList = Array.isArray(prdDocuments)
      ? prdDocuments.filter(isDraftPrdDocument)
      : []
    const featureNameStr = typeof featureName === 'string' ? featureName : undefined

    const draftId = deps.newDraftId()
    createDraft(deps.logsDir, {
      draftId,
      prdText,
      additionalNotes: typeof additionalNotes === 'string' ? additionalNotes : undefined,
      prdDocuments: documentList,
      repos: repoList,
      featureName: featureNameStr,
    })

    const rec = transitionDraft(deps, draftId, 'planning')
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-created', draft: rec })
    runPlanStage(deps, draftId).catch(() => {/* logged via draft.errorMessage */})

    reply.code(201)
    return { draftId, status: 'planning' }
  })

  app.get('/api/tests/draft', async () => {
    return listDrafts(deps.logsDir)
  })

  app.get<{ Params: { id: string } }>('/api/tests/draft/:id', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    const p = draftPaths(deps.logsDir, rec.draftId)
    return {
      ...rec,
      planAgentLogTail: tailIfExists(p.planAgentLog),
      specAgentLogTail: tailIfExists(p.specAgentLog),
    }
  })

  app.get<{
    Params: { id: string }
    Querystring: { stage?: string }
  }>('/api/tests/draft/:id/agent-log', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    const stage = req.query.stage
    if (stage !== 'planning' && stage !== 'generating') {
      reply.code(400)
      return { error: 'unknown draft stage' }
    }
    const p = draftPaths(deps.logsDir, rec.draftId)
    const logPath = stage === 'planning' ? p.planAgentLog : p.specAgentLog
    if (!fs.existsSync(logPath)) {
      reply.code(404)
      return { error: 'agent log not found' }
    }
    return { content: fs.readFileSync(logPath, 'utf8') }
  })

  // Structured agent-session snapshot for a draft. Equivalent to
  // /api/runs/:id/agent-session but keyed on draft + stage. Returns the
  // events parsed from the agent CLI's JSONL log at the time of the request.
  // The live WS at /ws/draft/:id/agent-session streams events as they arrive.
  app.get<{
    Params: { id: string }
    Querystring: { stage?: string }
  }>('/api/tests/draft/:id/agent-session', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { reason: 'draft-not-found' }
    }
    const stage = req.query.stage
    if (stage !== 'planning' && stage !== 'generating') {
      reply.code(400)
      return { reason: 'unknown-stage' }
    }
    const p = draftPaths(deps.logsDir, rec.draftId)
    const resolved = resolveDraftStageSessionRef({
      ref: stage === 'planning' ? rec.planAgentSessionRef : rec.specAgentSessionRef,
      agent: rec.wizardAgent,
      draftDir: p.draftDir,
      spawnedAt: stage === 'planning' ? rec.planAgentSpawnedAt : rec.specAgentSpawnedAt,
    })
    if (!resolved) {
      reply.code(404)
      return { reason: 'no-session-ref' }
    }
    if (!fs.existsSync(resolved.logPath)) {
      reply.code(404)
      return { reason: 'session-log-missing' }
    }
    return buildAgentSessionResponse(resolved)
  })

  app.post<{ Params: { id: string }; Body: { plan?: unknown; intentSummary?: string } }>(
    '/api/tests/draft/:id/accept-plan',
    async (req, reply) => {
      const rec = readDraft(deps.logsDir, req.params.id)
      if (!rec) {
        reply.code(404)
        return { error: 'draft not found' }
      }
      if (rec.status !== 'plan-ready') {
        reply.code(409)
        return { error: `cannot accept-plan from status ${rec.status}` }
      }
      const plan = req.body?.plan ?? rec.plan
      const submittedIntent = typeof req.body?.intentSummary === 'string' ? req.body.intentSummary.trim() : undefined
      const intentSummary = submittedIntent !== undefined && submittedIntent.length > 0
        ? submittedIntent
        : rec.intentSummary
      if (intentSummary !== undefined) {
        const p = draftPaths(deps.logsDir, rec.draftId)
        fs.writeFileSync(p.intentMd, intentSummary, 'utf8')
      }
      transitionDraft(deps, rec.draftId, 'generating', { plan, intentSummary })
      runSpecStage(deps, rec.draftId).catch(() => {/* logged via draft.errorMessage */})
      reply.code(202)
      return { draftId: rec.draftId, status: 'generating' }
    },
  )

  app.post<{ Params: { id: string }; Body: { featureName?: string } }>(
    '/api/tests/draft/:id/accept-spec',
    async (req, reply) => {
      const rec = readDraft(deps.logsDir, req.params.id)
      if (!rec) {
        reply.code(404)
        return { error: 'draft not found' }
      }
      if (rec.status !== 'spec-ready') {
        reply.code(409)
        return { error: `cannot accept-spec from status ${rec.status}` }
      }
      const featureName = req.body?.featureName ?? rec.featureName ?? defaultFeatureName(rec)
      const generated = readGeneratedFiles(deps.logsDir, rec.draftId)
      const generatedWithContextDocs = [
        ...generated,
        ...intentSummaryDocForDraft(rec),
        ...additionalNotesDocForDraft(rec),
      ]
      const validation = validateFeatureTarget(deps.projectRoot, featureName)
      if (!validation.ok) {
        reply.code(validation.error === 'feature-exists' ? 409 : 400)
        return { error: validation.error, featureDir: validation.featureDir }
      }
      const scaffold = validateGeneratedFeatureFiles(featureName, generatedWithContextDocs)
      if (!scaffold.ok) {
        reply.code(400)
        return { error: 'invalid-scaffold', details: scaffold.error }
      }
      const packageResult = mergeRootDevDependencies(deps.projectRoot, rec.devDependencies ?? [])
      if (!packageResult.ok) {
        reply.code(400)
        return { error: packageResult.error, packageJsonPath: packageResult.packageJsonPath }
      }
      const result = applyToProject({
        draftId: rec.draftId,
        featureName,
        generated: generatedWithContextDocs,
        projectRoot: deps.projectRoot,
      })
      if (!result.ok) {
        reply.code(result.error === 'feature-exists' ? 409 : 400)
        return { error: result.error, details: result.details, featureDir: result.featureDir }
      }
      const uploadedDocsWritten = writeUploadedDocumentCopies(result.featureDir, rec)
      transitionDraft(deps, rec.draftId, 'accepted', {
        featureName,
        generatedFiles: [...result.written, ...uploadedDocsWritten],
        devDependencies: rec.devDependencies,
      })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-created', feature: featureName })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: featureName })
      return {
        draftId: rec.draftId,
        status: 'accepted',
        featureDir: result.featureDir,
        devDependenciesAdded: packageResult.added,
      }
    },
  )

  app.post<{ Params: { id: string } }>('/api/tests/draft/:id/reject', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    if (isTransientGenerationStatus(rec.status)) {
      reply.code(409)
      return { error: `cannot reject while ${rec.status}; stop generation first` }
    }
    transitionDraft(deps, rec.draftId, 'rejected')
    reply.code(204)
    return null
  })

  app.post<{ Params: { id: string } }>('/api/tests/draft/:id/cancel-generation', async (req, reply) => {
    const rec = readDraft(deps.logsDir, req.params.id)
    if (!rec) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    if (!isTransientGenerationStatus(rec.status)) {
      reply.code(409)
      return { error: `cannot cancel-generation from status ${rec.status}` }
    }
    transitionDraft(deps, rec.draftId, 'cancelled', {
      activeAgentStage: undefined,
      errorMessage: 'Generation cancelled by user',
    })
    deps.cancelGeneration?.(rec.draftId)
    return { draftId: rec.draftId, status: 'cancelled' }
  })

  // Read a single generated file from a draft for the wizard's Spec Review
  // step. Path-traversal hardening lives in `draft-file-resolver`.
  app.get<{ Params: { id: string; '*': string } }>(
    '/api/tests/draft/:id/files/*',
    async (req, reply) => {
      const rec = readDraft(deps.logsDir, req.params.id)
      if (!rec) {
        reply.code(404)
        return { error: 'draft not found' }
      }
      // Fastify always populates a wildcard `*` param with a string.
      const requestPath = (req.params as { '*': string })['*']
      const resolved = resolveDraftFile(deps.logsDir, req.params.id, requestPath)
      if (!resolved.ok) {
        if (resolved.reason === 'invalid-path') {
          reply.code(400)
          return { error: 'invalid path' }
        }
        if (resolved.reason === 'outside-draft') {
          reply.code(400)
          return { error: 'path resolves outside draft' }
        }
        reply.code(404)
        return { error: 'file not found' }
      }
      const content = fs.readFileSync(resolved.absolute, 'utf-8')
      return { path: requestPath, content, mime: 'text/plain' }
    },
  )

  app.delete<{ Params: { id: string } }>('/api/tests/draft/:id', async (req, reply) => {
    const removed = deleteDraft(deps.logsDir, req.params.id)
    if (!removed) {
      reply.code(404)
      return { error: 'draft not found' }
    }
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-deleted', draftId: req.params.id })
    reply.code(204)
    return null
  })
}

// `runPlanStage` and `runSpecStage` are exported for tests so they can be
// awaited explicitly — the route handlers fire-and-forget them.
export { runPlanStage, runSpecStage }
