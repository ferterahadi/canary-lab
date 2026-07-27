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

describe('runPlanStage', () => {
  it('selects diff-only planning for drafts without documents or notes', () => {
    expect(selectPlanTemplate({ prdText: '   ', prdDocuments: [] })).toEqual({
      mode: 'diff-only',
      templatePath: STAGE1_DIFF_TEMPLATE,
    })
  })

  it('selects context planning when documents are present', () => {
    expect(selectPlanTemplate({
      prdText: '',
      prdDocuments: [{ filename: 'prd.md', contentType: 'text/markdown', characters: 10 }],
    })).toEqual({
      mode: 'context',
      templatePath: STAGE1_TEMPLATE,
    })
  })

  it('selects context planning when notes are present', () => {
    expect(selectPlanTemplate({ prdText: '   ', additionalNotes: 'checkout acceptance criteria', prdDocuments: [] })).toEqual({
      mode: 'context',
      templatePath: STAGE1_TEMPLATE,
    })
  })

  it('selects context planning when documents and notes are present', () => {
    expect(selectPlanTemplate({
      prdText: '',
      additionalNotes: 'checkout acceptance criteria',
      prdDocuments: [{ filename: 'prd.md', contentType: 'text/markdown', characters: 10 }],
    })).toEqual({
      mode: 'context',
      templatePath: STAGE1_TEMPLATE,
    })
  })

  it('transitions to error when wizard agent is unavailable', async () => {
    const deps = makeDeps({
      pickAgent: () => ({ ok: false, error: 'manual mode' }),
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    expect(rec.errorMessage).toBe('manual mode')
    await app.close()
  })

  it('writes plan.json and transitions to plan-ready', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const drafts = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')
    const id = drafts[0]
    await runPlanStage(deps, id) // explicit second invocation OK; transition guards prevent double-fire
      .catch(() => undefined)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    expect(fs.existsSync(path.join(logsDir, 'drafts', id, 'plan.json'))).toBe(true)
    await app.close()
  })

  it('persists the intent summary block to intent.md and the draft', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<intent-summary>
The test covers the login flow and asserts the dashboard greeting renders.
</intent-summary>
<plan-output>[
  {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
]</plan-output>`,
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    expect(rec.intentSummary).toContain('login flow')
    const intentBody = fs.readFileSync(path.join(logsDir, 'drafts', id, 'intent.md'), 'utf8')
    expect(intentBody).toContain('login flow')
    expect(intentBody).toContain('dashboard greeting')
    await app.close()
  })

  it('synthesizes a placeholder intent summary when the block is missing', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    expect(rec.intentSummary).toBe('No intent summary produced by agent.')
    expect(fs.readFileSync(path.join(logsDir, 'drafts', id, 'intent.md'), 'utf8')).toBe('No intent summary produced by agent.')
    await app.close()
  })

  it('stores the pinned claude session id for the plan agent', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
  {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
]</plan-output>`,
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    // claude pins its session id; the route resolves it without parsing the
    // stream (no formatter marker anymore). It's a generated UUID, so assert
    // shape, not an exact value, and that it matches the pre-spawn ref.
    expect(rec.planAgentSessionKind).toBe('claude')
    expect(typeof rec.planAgentSessionId).toBe('string')
    expect(rec.planAgentSessionId).toBeTruthy()
    await app.close()
  })

  it('transitions to error on parse failure', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => 'no markers here',
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    // Wait for fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    expect(rec.errorMessage).toMatch(/marker/)
    await app.close()
  })

  it('transitions to error on agent throw', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => { throw new Error('boom') },
    })
    const app = await makeApp(deps)
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    expect(rec.errorMessage).toMatch(/boom/)
    await app.close()
  })

  it('no-op when draft missing', async () => {
    const deps = makeDeps()
    await runPlanStage(deps, 'does-not-exist')
    // No throw; nothing changed.
  })
})

describe('runSpecStage error paths', () => {
  it('error on agent throw', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => { throw new Error('crash') },
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    expect(rec.errorMessage).toMatch(/crash/)
    await app.close()
  })

  it('error on file parse failure', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => 'no file blocks',
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    await app.close()
  })

  it('no-op when draft deleted before stage runs', async () => {
    const deps = makeDeps()
    await runSpecStage(deps, 'gone')
    // No throw.
  })

})

describe('runSpecStage agent-unavailable', () => {
  it('transitions to error when the wizard agent is unavailable at spec time', async () => {
    let calls = 0
    const deps = makeDeps({
      // First pick (plan) succeeds; second pick (spec) reports unavailable.
      pickAgent: () => (calls++ === 0 ? { ok: true, agent: 'claude' } : { ok: false, error: 'manual mode at spec' }),
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'app', localPath: '/p' }] },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('error')
    expect(rec.errorMessage).toBe('manual mode at spec')
    await app.close()
  })
})
