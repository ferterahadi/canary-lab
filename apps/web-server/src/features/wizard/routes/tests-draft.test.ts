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

import { paths as draftPaths, readDraft, writeDraft } from '../logic/draft-store'

import {
  runPlanStage,
  runSpecStage,
  selectPlanTemplate,
  testsDraftRoutes,
  type PlanAgentInput,
  type TestsDraftRouteDeps,
} from './tests-draft'

import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
} from '../logic/wizard-agent-spawner'

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

describe('POST /api/tests/draft', () => {
  it('creates a draft and starts planning without PRD text', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: '', repos: [{ name: 'app', localPath: '/p' }] },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().status).toBe('planning')
    await app.close()
  })

  it('starts diff-only planning when no documents or notes are provided', async () => {
    const spawnPlanAgent = vi.fn<(input: PlanAgentInput) => Promise<string>>(async () => '<plan-output>[]</plan-output>')
    const deps = makeDeps({ spawnPlanAgent })
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: '   ', prdDocuments: [], repos: [{ name: 'app', localPath: '/p' }] },
    })
    expect(r.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawnPlanAgent).toHaveBeenCalled()
    expect(spawnPlanAgent.mock.calls[0][0]).toMatchObject({
      prdText: '   ',
      planMode: 'diff-only',
      planTemplatePath: STAGE1_DIFF_TEMPLATE,
    })
    await app.close()
  })

  it('keeps context planning when notes are provided', async () => {
    const spawnPlanAgent = vi.fn<(input: PlanAgentInput) => Promise<string>>(async () => '<plan-output>[]</plan-output>')
    const deps = makeDeps({ spawnPlanAgent })
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'Login flow', prdDocuments: [], repos: [{ name: 'app', localPath: '/p' }] },
    })
    expect(r.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawnPlanAgent).toHaveBeenCalled()
    expect(spawnPlanAgent.mock.calls[0][0]).toMatchObject({
      prdText: 'Login flow',
      planMode: 'context',
      planTemplatePath: STAGE1_TEMPLATE,
    })
    await app.close()
  })

  it('keeps context planning when documents are provided', async () => {
    const spawnPlanAgent = vi.fn<(input: PlanAgentInput) => Promise<string>>(async () => '<plan-output>[]</plan-output>')
    const deps = makeDeps({ spawnPlanAgent })
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: '',
        prdDocuments: [{ filename: 'prd.md', contentType: 'text/markdown', characters: 10 }],
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    expect(r.statusCode).toBe(201)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawnPlanAgent).toHaveBeenCalled()
    expect(spawnPlanAgent.mock.calls[0][0]).toMatchObject({
      prdText: '',
      planMode: 'context',
      planTemplatePath: STAGE1_TEMPLATE,
    })
    await app.close()
  })

  it('400s when prdText is not a string', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: null, repos: [{ name: 'app', localPath: '/p' }] },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('400s on missing repos', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'login', repos: [] },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('jumps to planning when a valid draft is supplied', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"x","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
    })
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().status).toBe('planning')
    await app.close()
  })
})

describe('POST /api/tests/draft/:id/cancel-generation', () => {
  it('cancels planning and does not parse late plan output', async () => {
    let releasePlan!: (value: string) => void
    const cancelGeneration = vi.fn()
    const deps = makeDeps({
      cancelGeneration,
      spawnPlanAgent: async () => new Promise<string>((resolve) => { releasePlan = resolve }),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/cancel-generation` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ draftId: id, status: 'cancelled' })
    expect(cancelGeneration).toHaveBeenCalledExactlyOnceWith(id)

    releasePlan('<plan-output>[{"step":"late","actions":["x"],"expectedOutcome":"y"}]</plan-output>')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
    expect(fs.existsSync(path.join(logsDir, 'drafts', id, 'plan.json'))).toBe(false)
    await app.close()
  })

  it('moves transient drafts to cancelled even when no pty is registered', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => new Promise<string>(() => {}),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/cancel-generation` })
    expect(r.statusCode).toBe(200)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('cancelled')
    expect(rec.errorMessage).toBe('Generation cancelled by user')
    await app.close()
  })

  it('cancels generating status', async () => {
    const cancelGeneration = vi.fn()
    const app = await makeApp(makeDeps({
      cancelGeneration,
      spawnPlanAgent: async () => new Promise<string>(() => {}),
    }))
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!

    writeDraft(logsDir, { ...rec, status: 'generating' })
    const generating = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/cancel-generation` })
    expect(generating.statusCode).toBe(200)
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
    await app.close()
  })

  it('409s for non-transient drafts', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    writeDraft(logsDir, { ...rec, status: 'plan-ready' })
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/cancel-generation` })
    expect(r.statusCode).toBe(409)
    await app.close()
  })
})

describe('reject and delete', () => {
  it('rejects', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    writeDraft(logsDir, { ...rec, status: 'plan-ready' })
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/reject` })
    expect(r.statusCode).toBe(204)
    expect(readDraft(logsDir, id)?.status).toBe('rejected')
    await app.close()
  })

  it('does not reject while generation is active', async () => {
    const app = await makeApp(makeDeps({
      spawnPlanAgent: async () => new Promise<string>(() => {}),
    }))
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/reject` })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('stop generation first')
    expect(readDraft(logsDir, id)?.status).toBe('planning')
    await app.close()
  })

  it('reject 404', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/reject' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('deletes', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'DELETE', url: `/api/tests/draft/${id}` })
    expect(r.statusCode).toBe(204)
    expect(readDraft(logsDir, id)).toBeNull()
    await app.close()
  })

  it('delete 404', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'DELETE', url: '/api/tests/draft/nope' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })
})
