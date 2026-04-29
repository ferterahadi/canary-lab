import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import {
  applyToProject,
  createDraft,
  deleteDraft,
  listDrafts,
  paths as draftPaths,
  readDraft,
  slugifyFeatureName,
  transition,
  type DraftRecord,
  type DraftRepo,
} from '../lib/draft-store'
import {
  extractGeneratedFiles,
  extractPlan,
} from '../lib/wizard-output-parser'

// Wizard pipeline ports. The agent spawners are injected — production wires
// them to real `claude -p` pty invocations; tests pass synchronous stubs.
//
// Each spawner returns a promise resolving to the agent's full stdout once
// the agent exits. The route layer extracts the structured output from that
// stream via wizard-output-parser.

export interface PlanAgentInput {
  draftId: string
  prdText: string
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
}

export interface SpecAgentInput {
  draftId: string
  plan: unknown
  skills: { id: string; content: string }[]
  repos: DraftRepo[]
  draftDir: string
  agentLogPath: string
}

export interface TestsDraftRouteDeps {
  logsDir: string
  projectRoot: string
  newDraftId(): string
  spawnPlanAgent(input: PlanAgentInput): Promise<string>
  spawnSpecAgent(input: SpecAgentInput): Promise<string>
  // Optional skill content loader for stage-2 — tests stub it.
  loadSkillContent?(skillId: string): string
}

export async function testsDraftRoutes(
  app: FastifyInstance,
  deps: TestsDraftRouteDeps,
): Promise<void> {
  app.post<{
    Body: { prdText?: unknown; repos?: unknown; skills?: unknown; featureName?: unknown }
  }>('/api/tests/draft', async (req, reply) => {
    const prdText = req.body?.prdText
    const repos = req.body?.repos
    const skills = req.body?.skills
    const featureName = req.body?.featureName
    if (typeof prdText !== 'string' || !prdText.trim()) {
      reply.code(400)
      return { error: 'prdText required' }
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      reply.code(400)
      return { error: 'repos[] required' }
    }
    const repoList = repos.map((r) => r as DraftRepo)
    const skillList = Array.isArray(skills) ? (skills as string[]) : undefined
    const featureNameStr = typeof featureName === 'string' ? featureName : undefined

    const draftId = deps.newDraftId()
    const rec = createDraft(deps.logsDir, {
      draftId,
      prdText,
      repos: repoList,
      skills: skillList,
      featureName: featureNameStr,
    })

    // If skills were chosen up-front, jump to planning immediately. Otherwise
    // the client should call POST /api/skills/recommend separately and then
    // POST /api/tests/draft with the chosen skills.
    if (skillList && skillList.length > 0) {
      transition(deps.logsDir, draftId, 'planning')
      runPlanStage(deps, draftId).catch(() => {/* logged via draft.errorMessage */})
    }

    reply.code(201)
    return { draftId, status: skillList && skillList.length > 0 ? 'planning' : 'created' }
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
      const featureName = req.body?.featureName ?? rec.featureName ?? slugifyFeatureName(rec.prdText)
      const generated = readGeneratedFiles(deps.logsDir, rec.draftId)
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
      })
      return { draftId: rec.draftId, status: 'accepted', featureDir: result.featureDir }
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
  const p = draftPaths(deps.logsDir, draftId)
  let stream: string
  try {
    stream = await deps.spawnPlanAgent({
      draftId,
      prdText: rec.prdText,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.planAgentLog,
    })
  } catch (e) {
    transition(deps.logsDir, draftId, 'error', {
      errorMessage: `plan agent failed: ${(e as Error).message}`,
    })
    return
  }
  const parsed = extractPlan(stream)
  if (!parsed.ok) {
    transition(deps.logsDir, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.writeFileSync(p.planJson, JSON.stringify(parsed.value, null, 2), 'utf8')
  transition(deps.logsDir, draftId, 'plan-ready', { plan: parsed.value })
}

async function runSpecStage(deps: TestsDraftRouteDeps, draftId: string): Promise<void> {
  const rec = readDraft(deps.logsDir, draftId)
  if (!rec) return
  const p = draftPaths(deps.logsDir, draftId)
  const skillContents = (rec.skills ?? []).map((id) => ({
    id,
    content: deps.loadSkillContent ? deps.loadSkillContent(id) : '',
  }))
  let stream: string
  try {
    stream = await deps.spawnSpecAgent({
      draftId,
      plan: rec.plan,
      skills: skillContents,
      repos: rec.repos,
      draftDir: p.draftDir,
      agentLogPath: p.specAgentLog,
    })
  } catch (e) {
    transition(deps.logsDir, draftId, 'error', {
      errorMessage: `spec agent failed: ${(e as Error).message}`,
    })
    return
  }
  const parsed = extractGeneratedFiles(stream)
  if (!parsed.ok) {
    transition(deps.logsDir, draftId, 'error', { errorMessage: parsed.error })
    return
  }
  fs.mkdirSync(p.generatedDir, { recursive: true })
  for (const file of parsed.value) {
    const target = path.join(p.generatedDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  transition(deps.logsDir, draftId, 'spec-ready', {
    generatedFiles: parsed.value.map((f) => f.path),
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
