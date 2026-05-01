import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createServer } from './server'
import type { TestsDraftRouteDeps } from './routes/tests-draft'
import { writeManifest, writeRunsIndex, readManifest } from '../../shared/e2e-runner/manifest'
import { runDirFor } from '../../shared/e2e-runner/run-paths'

// Smoke test: exercises createServer() against the real templates/project
// tree, hitting every read-side endpoint via inject(). Lives next to the
// bootstrap so it doubles as the manual boot check evidence — running
// `npx vitest run apps/web-server/server.smoke.test.ts` is the closest we
// can get to a real boot inside the sandbox.

describe('createServer smoke (templates/project)', () => {
  it('binds to a real port and answers a request over HTTP', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, listSkills: () => [] })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      // Fastify returns "http://127.0.0.1:<port>".
      const res = await fetch(`${address}/api/features`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ name: string }>
      expect(body.map((f) => f.name).sort()).toEqual(
        expect.arrayContaining(['broken_todo_api', 'example_todo_api']),
      )
    } finally {
      await app.close()
    }
  })

  it('serves all read-side endpoints (features, runs, journal, skills, drafts)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({
      projectRoot,
      listSkills: () => [
        { id: 'user:demo', name: 'demo', description: 'a test skill', source: 'user', path: '/nope' },
      ],
    })
    try {
      const features = await app.inject({ method: 'GET', url: '/api/features' })
      expect(features.statusCode).toBe(200)
      const featuresJson = features.json() as Array<{ name: string }>
      const names = featuresJson.map((f) => f.name).sort()
      expect(names).toContain('example_todo_api')
      expect(names).toContain('broken_todo_api')

      const tests = await app.inject({
        method: 'GET',
        url: '/api/features/example_todo_api/tests',
      })
      expect(tests.statusCode).toBe(200)
      const testsJson = tests.json() as Array<{ file: string; tests: unknown[] }>
      expect(testsJson.length).toBeGreaterThan(0)

      const runs = await app.inject({ method: 'GET', url: '/api/runs' })
      expect(runs.statusCode).toBe(200)
      expect(Array.isArray(runs.json())).toBe(true)

      const journal = await app.inject({ method: 'GET', url: '/api/journal' })
      expect(journal.statusCode).toBe(200)
      expect(Array.isArray(journal.json())).toBe(true)

      // Skills list endpoint (Section 4 backend wiring).
      const skills = await app.inject({ method: 'GET', url: '/api/skills' })
      expect(skills.statusCode).toBe(200)
      const skillsJson = skills.json() as Array<{ id: string }>
      expect(skillsJson.map((s) => s.id)).toContain('user:demo')

      // Skill recommender endpoint.
      const rec = await app.inject({
        method: 'POST',
        url: '/api/skills/recommend',
        payload: { prdText: 'demo flow' },
      })
      expect(rec.statusCode).toBe(200)
      expect(Array.isArray(rec.json())).toBe(true)

      // Drafts list endpoint.
      const drafts = await app.inject({ method: 'GET', url: '/api/tests/draft' })
      expect(drafts.statusCode).toBe(200)
      expect(Array.isArray(drafts.json())).toBe(true)

      const unknown = await app.inject({ method: 'GET', url: '/api/runs/zzz' })
      expect(unknown.statusCode).toBe(404)

      const unknownFeature = await app.inject({
        method: 'GET',
        url: '/api/features/nope/tests',
      })
      expect(unknownFeature.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('createServer boot-time stale run cleanup', () => {
  let logsDir: string

  beforeEach(() => {
    logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-boot-reap-')))
  })

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true })
  })

  it('reaps a stale running entry from a previous process at startup', async () => {
    const runId = 'stale-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'example_todo_api',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'example_todo_api', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, listSkills: () => [] })
    try {
      const manifest = readManifest(path.join(dir, 'manifest.json'))
      expect(manifest?.status).toBe('aborted')
      expect(manifest?.endedAt).toBeDefined()

      const runs = await app.inject({ method: 'GET', url: '/api/runs' })
      const json = runs.json() as Array<{ runId: string; status: string }>
      expect(json.find((r) => r.runId === runId)?.status).toBe('aborted')
    } finally {
      await app.close()
    }
  })

  it('leaves a fresh-heartbeat running entry alone at startup', async () => {
    const runId = 'fresh-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'example_todo_api',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date().toISOString(),
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'example_todo_api', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, listSkills: () => [] })
    try {
      expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('running')
    } finally {
      await app.close()
    }
  })

  it('leaves a legacy manifest with no heartbeatAt alone at startup', async () => {
    const runId = 'legacy-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'example_todo_api',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      // no heartbeatAt — pre-feature manifest
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'example_todo_api', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, listSkills: () => [] })
    try {
      expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('running')
    } finally {
      await app.close()
    }
  })
})

describe('Add Test wizard end-to-end (mocked claude -p)', () => {
  let projectRoot: string
  let logsDir: string

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-e2e-proj-'))
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-e2e-logs-'))
  })

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
    fs.rmSync(logsDir, { recursive: true, force: true })
  })

  it('runs draft → plan-ready → accept-plan → spec-ready → accept-spec end to end', async () => {
    let counter = 0
    const planJson = JSON.stringify([
      {
        step: 'Open the login page',
        actions: ['Navigate to /login'],
        expectedOutcome: 'The form is visible.',
      },
      {
        step: 'Submit credentials',
        actions: ['Click sign-in'],
        expectedOutcome: 'Dashboard loads.',
      },
    ])
    const specStream = `<file path="feature.config.cjs">
module.exports = { name: 'login_flow', services: [] }
</file>
<file path="e2e/login.spec.ts">
import { test, expect } from '@playwright/test'
test('login', async ({ page }) => {
  await test.step('Open the login page', async () => {
    await page.goto('/login')
  })
  await test.step('Submit credentials', async () => {
    await expect(page).toHaveURL(/dashboard/)
  })
})
</file>`

    const overrides: Partial<TestsDraftRouteDeps> = {
      newDraftId: () => `d-${++counter}`,
      spawnPlanAgent: async (input) => {
        // Write something to the agent log so the route's tail helpers exercise.
        fs.mkdirSync(path.dirname(input.agentLogPath), { recursive: true })
        fs.writeFileSync(input.agentLogPath, 'plan agent ran', 'utf8')
        return `<plan-output>${planJson}</plan-output>`
      },
      spawnSpecAgent: async (input) => {
        fs.mkdirSync(path.dirname(input.agentLogPath), { recursive: true })
        fs.writeFileSync(input.agentLogPath, 'spec agent ran', 'utf8')
        return specStream
      },
      loadSkillContent: () => 'mock skill body',
    }

    const { app } = await createServer({
      projectRoot,
      logsDir,
      listSkills: () => [],
      testsDraftDepsOverride: overrides,
    })

    try {
      // Kick off the draft with skills already chosen so the route auto-runs
      // the plan stage.
      const created = await app.inject({
        method: 'POST',
        url: '/api/tests/draft',
        payload: {
          prdText: 'Login flow',
          repos: [{ name: 'app', localPath: '/p/app' }],
          skills: ['user:demo'],
          featureName: 'login_flow',
        },
      })
      expect(created.statusCode).toBe(201)
      const { draftId } = created.json() as { draftId: string }
      expect(draftId).toBe('d-1')

      // Poll until plan-ready.
      const draft = await waitForStatus(app, draftId, 'plan-ready')
      expect(draft.plan).toEqual(JSON.parse(planJson))

      // Accept the plan; spec stage fires-and-forgets.
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/tests/draft/${draftId}/accept-plan`,
        payload: {},
      })
      expect(accepted.statusCode).toBe(202)

      const specReady = await waitForStatus(app, draftId, 'spec-ready')
      expect(specReady.generatedFiles).toEqual(
        expect.arrayContaining(['feature.config.cjs', 'e2e/login.spec.ts']),
      )

      // Accept the spec — files materialize under features/<name>/.
      const finalRes = await app.inject({
        method: 'POST',
        url: `/api/tests/draft/${draftId}/accept-spec`,
        payload: {},
      })
      expect(finalRes.statusCode).toBe(200)
      const finalBody = finalRes.json() as { status: string; featureDir: string }
      expect(finalBody.status).toBe('accepted')

      const featureDir = path.join(projectRoot, 'features', 'login_flow')
      expect(fs.existsSync(path.join(featureDir, 'feature.config.cjs'))).toBe(true)
      expect(fs.existsSync(path.join(featureDir, 'e2e', 'login.spec.ts'))).toBe(true)
      const spec = fs.readFileSync(path.join(featureDir, 'e2e', 'login.spec.ts'), 'utf8')
      // Plan-step rule: each plan label appears verbatim as a test.step label.
      expect(spec).toContain(`test.step('Open the login page'`)
      expect(spec).toContain(`test.step('Submit credentials'`)
    } finally {
      await app.close()
    }
  })
})

async function waitForStatus(
  app: Awaited<ReturnType<typeof createServer>>['app'],
  draftId: string,
  target: string,
  timeoutMs = 2000,
): Promise<{ status: string; plan?: unknown; generatedFiles?: string[] }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${draftId}` })
    if (r.statusCode === 200) {
      const body = r.json() as { status: string; plan?: unknown; generatedFiles?: string[] }
      if (body.status === target) return body
      if (body.status === 'error') {
        throw new Error(`draft errored before reaching ${target}: ${JSON.stringify(body)}`)
      }
    }
    await new Promise((res) => setTimeout(res, 10))
  }
  throw new Error(`timed out waiting for status=${target}`)
}
