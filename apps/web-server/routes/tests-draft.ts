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
  extractPlan,
  extractWizardSessionRef,
} from '../lib/wizard-output-parser'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
} from '../lib/wizard-agent-spawner'
import { resolveDraftFile } from '../lib/draft-file-resolver'
import { combinePrdText, extractPrdDocument } from '../lib/prd-document-extractor'

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
}

export type PlanMode = 'context' | 'diff-only'

export interface SpecAgentInput {
  draftId: string
  agent: 'claude' | 'codex'
  featureName: string
  plan: unknown
  skills: { id: string; content: string }[]
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
  resumeSessionId?: string
}

export interface TestsDraftRouteDeps {
  logsDir: string
  projectRoot: string
  newDraftId(): string
  pickAgent?(): { ok: true; agent: 'claude' | 'codex' } | { ok: false; error: string }
  spawnPlanAgent(input: PlanAgentInput): Promise<string>
  spawnSpecAgent(input: SpecAgentInput): Promise<string>
  cancelGeneration?(draftId: string): boolean
  // Optional skill content loader for stage-2 — tests stub it.
  loadSkillContent?(skillId: string): string
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
        documents.push(await extractPrdDocument({
          filename: part.filename,
          contentType: part.mimetype,
          buffer,
        }))
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
      })),
    }
  })

  app.post<{
    Body: { prdText?: unknown; prdDocuments?: unknown; repos?: unknown; skills?: unknown; featureName?: unknown }
  }>('/api/tests/draft', async (req, reply) => {
    const prdText = req.body?.prdText
    const prdDocuments = req.body?.prdDocuments
    const repos = req.body?.repos
    const skills = req.body?.skills
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
    const skillList = Array.isArray(skills) ? (skills as string[]) : undefined
    const featureNameStr = typeof featureName === 'string' ? featureName : undefined

    const draftId = deps.newDraftId()
    const rec = createDraft(deps.logsDir, {
      draftId,
      prdText,
      prdDocuments: documentList,
      repos: repoList,
      skills: skillList,
      featureName: featureNameStr,
    })

    transition(deps.logsDir, draftId, 'planning')
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

  app.post<{ Params: { id: string }; Body: { plan?: unknown } }>(
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
      transition(deps.logsDir, rec.draftId, 'generating', { plan })
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
      const validation = validateFeatureTarget(deps.projectRoot, featureName)
      if (!validation.ok) {
        reply.code(validation.error === 'feature-exists' ? 409 : 400)
        return { error: validation.error, featureDir: validation.featureDir }
      }
      const packageResult = mergeRootDevDependencies(deps.projectRoot, rec.devDependencies ?? [])
      if (!packageResult.ok) {
        reply.code(400)
        return { error: packageResult.error, packageJsonPath: packageResult.packageJsonPath }
      }
      const result = applyToProject({
        draftId: rec.draftId,
        featureName,
        generated,
        projectRoot: deps.projectRoot,
      })
      if (!result.ok) {
        reply.code(result.error === 'feature-exists' ? 409 : 400)
        return { error: result.error, featureDir: result.featureDir }
      }
      transition(deps.logsDir, rec.draftId, 'accepted', {
        featureName,
        generatedFiles: result.written,
        devDependencies: rec.devDependencies,
      })
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
    transition(deps.logsDir, rec.draftId, 'rejected')
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
    transition(deps.logsDir, rec.draftId, 'cancelled', {
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
      const requestPath = (req.params as { '*': string })['*'] ?? ''
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
    transition(deps.logsDir, draftId, 'error', { errorMessage: picked.error })
    return
  }
  patchDraft(deps.logsDir, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'planning',
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'planning')) return
  const p = draftPaths(deps.logsDir, draftId)
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
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transition(deps.logsDir, draftId, 'error', {
      errorMessage: `plan agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractPlan(stream)
  if (!parsed.ok) {
    transition(deps.logsDir, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.writeFileSync(p.planJson, JSON.stringify(parsed.value, null, 2), 'utf8')
  const sessionRef = extractWizardSessionRef(stream)
  transition(deps.logsDir, draftId, 'plan-ready', {
    plan: parsed.value,
    activeAgentStage: undefined,
    ...(sessionRef
      ? { planAgentSessionId: sessionRef.id, planAgentSessionKind: sessionRef.kind }
      : {}),
  })
}

export function hasUserContext(rec: Pick<DraftRecord, 'prdText' | 'prdDocuments'>): boolean {
  return rec.prdText.trim().length > 0 || rec.prdDocuments.length > 0
}

export function selectPlanTemplate(rec: Pick<DraftRecord, 'prdText' | 'prdDocuments'>): {
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
    transition(deps.logsDir, draftId, 'error', { errorMessage: picked.error })
    return
  }
  patchDraft(deps.logsDir, draftId, {
    wizardAgent: picked.agent,
    activeAgentStage: 'generating',
  })
  if (!isStageCurrent(deps.logsDir, draftId, 'generating')) return
  const p = draftPaths(deps.logsDir, draftId)
  const skillContents = (rec.skills ?? []).map((id) => ({
    id,
    content: deps.loadSkillContent ? deps.loadSkillContent(id) : '',
  }))
  let stream: string
  const resumeSessionId = rec.planAgentSessionKind === picked.agent
    ? rec.planAgentSessionId
    : undefined
  try {
    stream = await deps.spawnSpecAgent({
      draftId,
      agent: picked.agent,
      featureName: rec.featureName ?? defaultFeatureName(rec),
      plan: rec.plan,
      skills: skillContents,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.specAgentLog,
      resumeSessionId,
    })
  } catch (e) {
    if (isCancelled(deps.logsDir, draftId)) return
    transition(deps.logsDir, draftId, 'error', {
      errorMessage: `spec agent failed: ${(e as Error).message}`,
    })
    return
  }
  if (isCancelled(deps.logsDir, draftId)) return
  const parsed = extractGeneratedSpecOutput(stream)
  if (!parsed.ok) {
    transition(deps.logsDir, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.mkdirSync(p.generatedDir, { recursive: true })
  for (const file of parsed.value.files) {
    const target = path.join(p.generatedDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  transition(deps.logsDir, draftId, 'spec-ready', {
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

function patchDraft(logsDir: string, draftId: string, patch: Partial<DraftRecord>): void {
  const rec = readDraft(logsDir, draftId)
  if (!rec) return
  writeDraft(logsDir, { ...rec, ...patch })
}

function isDraftPrdDocument(value: unknown): value is DraftPrdDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<DraftPrdDocument>
  return typeof doc.filename === 'string'
    && typeof doc.contentType === 'string'
    && typeof doc.characters === 'number'
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
