import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRef } from '../../agent-sessions/logic/agent-session-log'

// Pass-through mock for the session-ref resolver. Tests can install a one-shot
// override to exercise the route's TOCTOU guard (a ref that resolves but whose
// log file no longer exists by the time the handler stats it).
let resolveSessionRefOverride: (() => AgentSessionRef | null) | null = null

vi.mock('../logic/draft-agent-session', async () => {
  const actual = await vi.importActual<typeof import('../logic/draft-agent-session')>('../logic/draft-agent-session')
  return {
    ...actual,
    resolveDraftStageSessionRef: (input: Parameters<typeof actual.resolveDraftStageSessionRef>[0]) => {
      if (resolveSessionRefOverride) {
        const override = resolveSessionRefOverride
        resolveSessionRefOverride = null
        return override()
      }
      return actual.resolveDraftStageSessionRef(input)
    },
  }
})

// Pass-through mock for applyToProject so a test can force its not-ok return
// (a TOCTOU race: the feature dir appears between the route's pre-checks and
// the apply call — defense-in-depth that is otherwise unreachable).
let applyToProjectOverride: (() => { ok: false; error: string; details?: string; featureDir?: string }) | null = null

// Pass-through mock for resolveDraftFile so a test can force the outside-draft
// reason (defence-in-depth: the route already rejects `..` and leading slashes,
// so the resolver never actually emits outside-draft from route input).
let resolveDraftFileOverride: (() => { ok: false; reason: 'invalid-path' | 'outside-draft' | 'not-found' }) | null = null

vi.mock('../logic/draft-store', async () => {
  const actual = await vi.importActual<typeof import('../logic/draft-store')>('../logic/draft-store')
  return {
    ...actual,
    applyToProject: (input: Parameters<typeof actual.applyToProject>[0]) => {
      if (applyToProjectOverride) {
        const override = applyToProjectOverride
        applyToProjectOverride = null
        return override()
      }
      return actual.applyToProject(input)
    },
  }
})

vi.mock('../logic/draft-file-resolver', async () => {
  const actual = await vi.importActual<typeof import('../logic/draft-file-resolver')>('../logic/draft-file-resolver')
  return {
    ...actual,
    resolveDraftFile: (logsDir: string, draftId: string, requestPath: string) => {
      if (resolveDraftFileOverride) {
        const override = resolveDraftFileOverride
        resolveDraftFileOverride = null
        return override()
      }
      return actual.resolveDraftFile(logsDir, draftId, requestPath)
    },
  }
})

import {
  runPlanStage,
  runSpecStage,
  selectPlanTemplate,
  testsDraftRoutes,
  type PlanAgentInput,
  type TestsDraftRouteDeps,
} from './tests-draft'

import { buildFeatureScaffold, canonicalScaffoldPaths, type GeneratedFeatureFile } from '../../../../../../shared/feature-scaffold'

let logsDir: string

let projectRoot: string

beforeEach(() => {
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-draft-logs-'))
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-draft-proj-'))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

let counter = 0

function makeDeps(overrides: Partial<TestsDraftRouteDeps> = {}): TestsDraftRouteDeps {
  return {
    logsDir,
    projectRoot,
    newDraftId: () => `d-${++counter}`,
    spawnPlanAgent: async () => '<plan-output>[]</plan-output>',
    spawnSpecAgent: async () => '<file path="x.ts">x</file>',
    ...overrides,
  }
}

async function makeApp(deps: TestsDraftRouteDeps): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify()
  await testsDraftRoutes(app, deps)
  return app
}

function fileBlocks(files: GeneratedFeatureFile[]): string {
  return files.map((file) => `<file path="${file.path}">\n${file.content}</file>`).join('\n')
}

describe('accept-spec validation branches', () => {
  it('400s with invalid-name when the feature name is illegal', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'ok_feature' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }], featureName: 'ok_feature' },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-spec`,
      payload: { featureName: 'Has Spaces!' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid-name')
    await app.close()
  })

  it('uses an explicit body featureName branch on accept-spec', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'body_name' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }], featureName: 'body_name' },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    // Pass featureName in the body so the `req.body?.featureName ?? ...` branch
    // takes its first operand rather than falling through to the draft record.
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-spec`,
      payload: { featureName: 'body_name' },
    })
    expect(r.statusCode).toBe(200)
    expect(fs.existsSync(path.join(projectRoot, 'features', 'body_name'))).toBe(true)
    await app.close()
  })

  it('409s when applyToProject reports feature-exists after the pre-checks pass', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'race_exists' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }], featureName: 'race_exists' },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    // Force the apply-time race where the dir materialised after validation.
    applyToProjectOverride = () => ({ ok: false, error: 'feature-exists', featureDir: '/tmp/x' })
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ error: 'feature-exists', featureDir: '/tmp/x' })
    await app.close()
  })

  it('400s when applyToProject reports a non-feature-exists error after the pre-checks pass', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'race_invalid' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }], featureName: 'race_invalid' },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    applyToProjectOverride = () => ({ ok: false, error: 'invalid-scaffold', details: 'apply-time check' })
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toMatchObject({ error: 'invalid-scaffold', details: 'apply-time check' })
    await app.close()
  })

  it('falls back to the default feature name derived from the repo when none is given', async () => {
    // prdText with no alphanumerics slugifies to untitled-feature, forcing the
    // repo-derived fallback inside defaultFeatureName.
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async (input) => fileBlocks(buildFeatureScaffold({ featureName: input.featureName })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: '!!!', repos: [{ name: 'CheckoutApp', localPath: '/p' }] },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(200)
    expect(fs.existsSync(path.join(projectRoot, 'features', 'checkoutapp-e2e-tests'))).toBe(true)
    await app.close()
  })
})
