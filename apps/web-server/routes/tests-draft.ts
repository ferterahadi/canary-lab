import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import {
  applyToProject,
  mergeRootDevDependencies,
  writeDraft,
  createDraft,
  deleteDraft,
  listDrafts,
  paths as draftPaths,
  readDraft,
  slugifyFeatureName,
  transition,
  validateFeatureTarget,
  type DraftRecord,
  type DraftPrdDocument,
  type DraftRepo,
} from '../lib/draft-store'
import {
  extractGeneratedSpecOutput,
  extractIntentSummary,
  extractPlan,
  extractWizardSessionRef,
} from '../lib/wizard-output-parser'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
} from '../lib/wizard-agent-spawner'
import { refForAgentSpawn } from '../lib/agent-session-tailer'
import {
  loadAgentSessionLog,
} from '../lib/agent-session-log'
import { resolveDraftStageSessionRef } from '../lib/draft-agent-session'
import { randomUUID } from 'crypto'
import { validateGeneratedFeatureFiles } from '../../../shared/feature-scaffold'
import { resolveDraftFile } from '../lib/draft-file-resolver'
import { combinePrdText, extractPrdDocument } from '../lib/prd-document-extractor'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../lib/workspace-events'

// Wizard pipeline ports. The agent spawners are injected — production wires
// them to real `claude -p` pty invocations; tests pass synchronous stubs.
//
// Each spawner returns a promise resolving to the agent's full stdout once
// the agent exits. The route layer extracts the structured output from that
// stream via wizard-output-parser.

export interface PlanAgentInput {
  draftId: string
  agent: 'claude' | 'codex'
  prdText: string
  planMode?: PlanMode
  planTemplatePath?: string
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
  // Session id to pass via `--session-id` (claude only). Lets the live
  // structured-event WS tail the agent's JSONL from t=0. Undefined for codex.
  pinSessionId?: string
}

export type PlanMode = 'context' | 'diff-only'

export interface SpecAgentInput {
  draftId: string
  agent: 'claude' | 'codex'
  featureName: string
  plan: unknown
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
  resumeSessionId?: string
  pinSessionId?: string
}

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
    const events = loadAgentSessionLog(resolved)
    return { agent: resolved.agent, sessionId: resolved.sessionId, events }
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

// ---- pipeline drivers (tested via accept-plan / spec-ready transitions) ----

async function runPlanStage(deps: TestsDraftRouteDeps, draftId: string): Promise<void> {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  if (rec.status !== 'planning') return
  const picked = pickWizardAgent(deps)
  if (!picked.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: picked.error })
    return
  }
  const p = draftPaths(deps.logsDir, draftId)
  // Pin the claude session id (codex has no equivalent) so the live agent-
  // session WS can tail the JSONL log from the moment of spawn.
  const pinSessionId = picked.agent === 'claude' ? randomUUID() : undefined
  const planAgentSessionRef = refForAgentSpawn({ agent: picked.agent, cwd: p.draftDir, sessionId: pinSessionId })
  patchDraft(deps, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'planning',
    planAgentSessionRef,
    planAgentSpawnedAt: new Date().toISOString(),
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'planning')) return
  const planTemplate = selectPlanTemplate(rec)
  let stream: string
  try {
    stream = await deps.spawnPlanAgent({
      draftId,
      agent: picked.agent,
      prdText: rec.prdText,
      planMode: planTemplate.mode,
      planTemplatePath: planTemplate.templatePath,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.planAgentLog,
      pinSessionId,
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transitionDraft(deps, draftId, 'error', {
      errorMessage: `plan agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractPlan(stream)
  if (!parsed.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.writeFileSync(p.planJson, JSON.stringify(parsed.value, null, 2), 'utf8')
  const intent = extractIntentSummary(stream)
  const intentSummary = intent.ok ? intent.value : 'No intent summary produced by agent.'
  fs.writeFileSync(p.intentMd, intentSummary, 'utf8')
  const sessionRef = extractWizardSessionRef(stream)
  transitionDraft(deps, draftId, 'plan-ready', {
    plan: parsed.value,
    intentSummary,
    activeAgentStage: undefined,
    ...(sessionRef
      ? { planAgentSessionId: sessionRef.id, planAgentSessionKind: sessionRef.kind }
      : {}),
  })
}

export function hasUserContext(rec: Pick<DraftRecord, 'prdText' | 'additionalNotes' | 'prdDocuments'>): boolean {
  return rec.prdText.trim().length > 0
    || (rec.additionalNotes?.trim().length ?? 0) > 0
    || rec.prdDocuments.length > 0
}

export function selectPlanTemplate(rec: Pick<DraftRecord, 'prdText' | 'additionalNotes' | 'prdDocuments'>): {
  mode: PlanMode
  templatePath: string
} {
  return hasUserContext(rec)
    ? { mode: 'context', templatePath: STAGE1_TEMPLATE }
    : { mode: 'diff-only', templatePath: STAGE1_DIFF_TEMPLATE }
}

async function runSpecStage(deps: TestsDraftRouteDeps, draftId: string): Promise<void> {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  if (rec.status !== 'generating') return
  const picked = pickWizardAgent(deps)
  if (!picked.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: picked.error })
    return
  }
  const p = draftPaths(deps.logsDir, draftId)
  const resumeSessionId = rec.planAgentSessionKind === picked.agent
    ? rec.planAgentSessionId
    : undefined
  // Pin the spec agent's claude session id too. If we're resuming, the
  // session id is fixed by the prior agent — reuse it so the JSONL keeps
  // appending to the same file (claude's `--resume` writes to the same path).
  const pinSessionId = picked.agent === 'claude'
    ? (resumeSessionId ?? randomUUID())
    : undefined
  const specAgentSessionRef = refForAgentSpawn({ agent: picked.agent, cwd: p.draftDir, sessionId: pinSessionId })
  patchDraft(deps, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'generating',
    specAgentSessionRef,
    specAgentSpawnedAt: new Date().toISOString(),
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'generating')) return
  let stream: string
  try {
    stream = await deps.spawnSpecAgent({
      draftId,
      agent: picked.agent,
      featureName: rec.featureName ?? defaultFeatureName(rec),
      plan: rec.plan,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.specAgentLog,
      resumeSessionId,
      pinSessionId: resumeSessionId ? undefined : pinSessionId,
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transitionDraft(deps, draftId, 'error', {
      errorMessage: `spec agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractGeneratedSpecOutput(stream)
  if (!parsed.ok) {
    transitionDraft(deps, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.mkdirSync(p.generatedDir, { recursive: true })
  for (const file of parsed.value.files) {
    const target = path.join(p.generatedDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  transitionDraft(deps, draftId, 'spec-ready', {
    generatedFiles: parsed.value.files.map((f) => f.path),
    devDependencies: parsed.value.devDependencies,
    activeAgentStage: undefined,
  })
}

// ---- helpers ----

function tailIfExists(file: string, bytes = 4096): string {
  if (!fs.existsSync(file)) return ''
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - bytes)
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function pickWizardAgent(deps: TestsDraftRouteDeps): { ok: true; agent: 'claude' | 'codex' } | { ok: false; error: string } {
  return deps.pickAgent?.() ?? { ok: true, agent: 'claude' }
}

function isTransientGenerationStatus(status: DraftRecord['status']): boolean {
  return status === 'planning' || status === 'generating'
}

function isCancelled(logsDir: string, draftId: string): boolean {
  return readDraft(logsDir, draftId)?.status === 'cancelled'
}

function isStageCurrent(logsDir: string, draftId: string, status: DraftRecord['status']): boolean {
  return readDraft(logsDir, draftId)?.status === status
}

function transitionDraft(
  deps: TestsDraftRouteDeps,
  draftId: string,
  status: DraftRecord['status'],
  patch?: Partial<DraftRecord>,
): DraftRecord {
  const next = transition(deps.logsDir, draftId, status, patch)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
  return next
}

function patchDraft(deps: TestsDraftRouteDeps, draftId: string, patch: Partial<DraftRecord>): void {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  const next = { ...rec, ...patch }
  writeDraft(deps.logsDir, next)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
}

function isDraftPrdDocument(value: unknown): value is DraftPrdDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<DraftPrdDocument>
  return typeof doc.filename === 'string'
    && typeof doc.contentType === 'string'
    && typeof doc.characters === 'number'
    && (doc.text === undefined || typeof doc.text === 'string')
    && (doc.contentBase64 === undefined || typeof doc.contentBase64 === 'string')
}

function additionalNotesDocForDraft(rec: DraftRecord): { path: string; content: string }[] {
  const notes = rec.additionalNotes?.trim()
  return notes
    ? [{
        path: 'docs/additional-notes.md',
        content: `# Additional notes\n\n${notes}\n`,
      }]
    : []
}

function intentSummaryDocForDraft(rec: DraftRecord): { path: string; content: string }[] {
  const summary = rec.intentSummary?.trim()
  return summary
    ? [{
        path: 'docs/intent.md',
        content: `# Intent summary\n\n${summary}\n`,
      }]
    : []
}

function writeUploadedDocumentCopies(featureDir: string, rec: DraftRecord): string[] {
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

function uniqueUploadedFilename(featureDir: string, filename: string, used: Set<string>): string {
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

function safeUploadedFilename(filename: string): string {
  const base = filename.replace(/[\\/]+/g, '-').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!base || base === '.' || base === '..') return 'document'
  return base
}

function defaultFeatureName(rec: DraftRecord): string {
  const fromPrd = slugifyFeatureName(rec.prdText)
  if (fromPrd !== 'untitled-feature') return fromPrd
  const firstRepo = rec.repos[0]
  if (!firstRepo) return fromPrd
  return slugifyFeatureName(`${firstRepo.name} e2e tests`)
}

function readGeneratedFiles(logsDir: string, draftId: string): { path: string; content: string }[] {
  const p = draftPaths(logsDir, draftId)
  if (!fs.existsSync(p.generatedDir)) return []
  return walk(p.generatedDir, p.generatedDir)
}

function walk(root: string, dir: string): { path: string; content: string }[] {
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

// `runPlanStage` and `runSpecStage` are exported for tests so they can be
// awaited explicitly — the route handlers fire-and-forget them.
export { runPlanStage, runSpecStage }
