import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDraft, writeDraft } from '../lib/draft-store'
import {
  runPlanStage,
  runSpecStage,
  selectPlanTemplate,
  testsDraftRoutes,
  type TestsDraftRouteDeps,
} from './tests-draft'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
} from '../lib/wizard-agent-spawner'

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
  it('creates a draft and starts planning without skills or PRD text', async () => {
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
    const spawnPlanAgent = vi.fn(async () => '<plan-output>[]</plan-output>')
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
    const spawnPlanAgent = vi.fn(async () => '<plan-output>[]</plan-output>')
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
    const spawnPlanAgent = vi.fn(async () => '<plan-output>[]</plan-output>')
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

  it('jumps to planning when skills supplied', async () => {
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
        skills: ['s1'],
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
    expect(selectPlanTemplate({ prdText: 'checkout acceptance criteria', prdDocuments: [] })).toEqual({
      mode: 'context',
      templatePath: STAGE1_TEMPLATE,
    })
  })

  it('selects context planning when documents and notes are present', () => {
    expect(selectPlanTemplate({
      prdText: 'checkout acceptance criteria',
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
        skills: ['s1'],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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
        skills: ['s1'],
      },
    })
    const drafts = fs.readdirSync(path.join(logsDir, 'drafts'))
    const id = drafts[0]
    await runPlanStage(deps, id) // explicit second invocation OK; transition guards prevent double-fire
      .catch(() => undefined)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    expect(fs.existsSync(path.join(logsDir, 'drafts', id, 'plan.json'))).toBe(true)
    await app.close()
  })

  it('stores the plan agent session id when the formatter exposes one', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `[[canary-lab:wizard-session agent=claude id=sess-plan-123]]
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
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
    await new Promise((r) => setTimeout(r, 10))
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('plan-ready')
    expect(rec.planAgentSessionId).toBe('sess-plan-123')
    expect(rec.planAgentSessionKind).toBe('claude')
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
        skills: ['s1'],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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
        skills: ['s1'],
      },
    })
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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

describe('GET /api/tests/draft/:id', () => {
  it('404s on unknown id', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'GET', url: '/api/tests/draft/nope' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('returns full record with log tails', async () => {
    const deps = makeDeps()
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
    fs.writeFileSync(path.join(logsDir, 'drafts', id, 'plan-agent.log'), 'tail content', 'utf8')
    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}` })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.draftId).toBe(id)
    expect(body.planAgentLogTail).toBe('tail content')
    await app.close()
  })
})

describe('GET /api/tests/draft/:id/agent-log', () => {
  it('returns the full agent log for a draft stage', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = post.json().draftId
    const content = `start\n${'x'.repeat(5000)}\nend`
    fs.writeFileSync(path.join(logsDir, 'drafts', id, 'plan-agent.log'), content, 'utf8')

    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-log?stage=planning` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ content })
    await app.close()
  })

  it('rejects unknown stages', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = post.json().draftId

    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-log?stage=refining` })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'unknown draft stage' })
    await app.close()
  })

  it('404s unknown drafts and missing logs', async () => {
    const app = await makeApp(makeDeps())
    const missingDraft = await app.inject({ method: 'GET', url: '/api/tests/draft/nope/agent-log?stage=planning' })
    expect(missingDraft.statusCode).toBe(404)

    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
      },
    })
    const id = post.json().draftId
    const missingLog = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-log?stage=generating` })
    expect(missingLog.statusCode).toBe(404)
    expect(missingLog.json()).toEqual({ error: 'agent log not found' })
    await app.close()
  })
})

describe('GET /api/tests/draft (list)', () => {
  it('returns all drafts newest first', async () => {
    const app = await makeApp(makeDeps())
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'A', repos: [{ name: 'a', localPath: '/' }] },
    })
    await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'B', repos: [{ name: 'b', localPath: '/' }] },
    })
    const r = await app.inject({ method: 'GET', url: '/api/tests/draft' })
    expect(r.statusCode).toBe(200)
    expect((r.json() as unknown[]).length).toBe(2)
    await app.close()
  })
})

describe('POST /api/tests/draft/:id/accept-plan', () => {
  it('starts spec stage and returns 202', async () => {
    let specCalled = 0
    const deps = makeDeps({
      spawnSpecAgent: async (input) => {
        specCalled++
        expect(input.resumeSessionId).toBeUndefined()
        return '<file path="feature.config.cjs">module.exports={};</file>'
      },
    })
    const app = await makeApp(deps)
    // Manually drive a draft into plan-ready
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['s1'],
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 10)) // let plan stage settle (default mock returns [])
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: {},
    })
    expect(r.statusCode).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    expect(specCalled).toBe(1)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('spec-ready')
    await app.close()
  })

  it('resumes the matching plan agent session and still uses the accepted edited plan', async () => {
    let specInput: Parameters<TestsDraftRouteDeps['spawnSpecAgent']>[0] | undefined
    const editedPlan = [
      { step: 'Edited step', actions: ['edited action'], expectedOutcome: 'edited outcome' },
    ]
    const deps = makeDeps({
      pickAgent: () => ({ ok: true, agent: 'claude' }),
      spawnPlanAgent: async () => `[[canary-lab:wizard-session agent=claude id=sess-plan-123]]
<plan-output>[
  {"step":"Original","actions":["go"],"expectedOutcome":"visible"}
]</plan-output>`,
      spawnSpecAgent: async (input) => {
        specInput = input
        return '<file path="feature.config.cjs">module.exports={};</file>'
      },
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
    await new Promise((r) => setTimeout(r, 10))
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: { plan: editedPlan },
    })
    expect(r.statusCode).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    expect(specInput?.resumeSessionId).toBe('sess-plan-123')
    expect(specInput?.plan).toEqual(editedPlan)
    await app.close()
  })

  it('falls back to a fresh spec agent when the saved plan session belongs to another agent', async () => {
    let specInput: Parameters<TestsDraftRouteDeps['spawnSpecAgent']>[0] | undefined
    const deps = makeDeps({
      pickAgent: () => ({ ok: true, agent: 'codex' }),
      spawnPlanAgent: async () => `[[canary-lab:wizard-session agent=claude id=sess-plan-123]]
<plan-output>[
  {"step":"Original","actions":["go"],"expectedOutcome":"visible"}
]</plan-output>`,
      spawnSpecAgent: async (input) => {
        specInput = input
        return '<file path="feature.config.cjs">module.exports={};</file>'
      },
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
    await new Promise((r) => setTimeout(r, 10))
    await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: {},
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(specInput?.resumeSessionId).toBeUndefined()
    await app.close()
  })

  it('409s when status is wrong', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    writeDraft(logsDir, { ...rec, status: 'accepted' })
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: {},
    })
    expect(r.statusCode).toBe(409)
    await app.close()
  })

  it('404s on unknown', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/accept-plan' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })
})

describe('POST /api/tests/draft/:id/accept-spec', () => {
  it('writes files into features/<name>/ and transitions to accepted', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async (input) => {
        expect(input.featureName).toBe('login')
        return `<file path="feature.config.cjs">
const config = {
  name: 'login',
  description: 'Login flow',
  envs: ['local'],
  repos: [],
  featureDir: __dirname,
}
module.exports = { config }
</file>
<file path="playwright.config.cjs">
const path = require('node:path')
const { config: loadDotenv } = require('dotenv')
const { defineConfig } = require('@playwright/test')
const { baseConfig } = require('canary-lab/feature-support/playwright-base')
loadDotenv({ path: path.join(__dirname, '.env') })
module.exports = defineConfig({ ...baseConfig })
</file>
<file path="e2e/login.spec.ts">
import { test } from 'canary-lab/feature-support/log-marker-fixture';
test('x', async () => {});
</file>`
      },
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login flow',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['s1'],
        featureName: 'login',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: {},
    })
    await new Promise((r) => setTimeout(r, 20))
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-spec`,
      payload: {},
    })
    expect(r.statusCode).toBe(200)
    const featureDir = path.join(projectRoot, 'features', 'login')
    expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf8')).toContain("name: 'login'")
    expect(fs.readFileSync(path.join(featureDir, 'playwright.config.cjs'), 'utf8')).toContain('baseConfig')
    expect(fs.readFileSync(path.join(featureDir, 'e2e/login.spec.ts'), 'utf8')).toContain("test('x'")
    expect(fs.existsSync(path.join(featureDir, '.canary-lab-draft-id'))).toBe(false)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('accepted')
    await app.close()
  })

  it('merges generated dev dependencies into root package.json on accept', async () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'proj',
      dependencies: { mysql2: '^3.0.0' },
      devDependencies: { 'canary-lab': '^1.0.0' },
    }, null, 2))
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async () => `<file path="feature.config.cjs">module.exports = { config: { name: 'deps' } }</file>
<file path="playwright.config.cjs">module.exports = {}</file>
<file path="e2e/deps.spec.ts">import amqplib from 'amqplib'</file>
<dev-dependencies>
["amqplib","mysql2"]
</dev-dependencies>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Deps flow',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['s1'],
        featureName: 'deps',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const ready = readDraft(logsDir, id)!
    expect(ready.devDependencies).toEqual(['amqplib', 'mysql2'])
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(200)
    expect(r.json().devDependenciesAdded).toEqual(['amqplib'])
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toEqual({ mysql2: '^3.0.0' })
    expect(pkg.devDependencies).toEqual({ 'canary-lab': '^1.0.0', amqplib: 'latest' })
    await app.close()
  })

  it('returns a clear error and writes no feature when package.json is malformed', async () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), 'not-json')
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async () => `<file path="feature.config.cjs">x</file>
<dev-dependencies>["mysql2"]</dev-dependencies>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Bad package',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['s1'],
        featureName: 'badpkg',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('package-json-invalid')
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe('not-json')
    expect(fs.existsSync(path.join(projectRoot, 'features', 'badpkg'))).toBe(false)
    await app.close()
  })

  it('409s when feature dir already exists', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => `<file path="feature.config.cjs">x</file>`,
    })
    const app = await makeApp(deps)
    fs.mkdirSync(path.join(projectRoot, 'features', 'login'), { recursive: true })
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['s1'],
        featureName: 'login',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: {},
    })
    await new Promise((r) => setTimeout(r, 20))
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-spec`,
      payload: {},
    })
    expect(r.statusCode).toBe(409)
    await app.close()
  })

  it('409 on wrong status', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec` })
    expect(r.statusCode).toBe(409)
    await app.close()
  })

  it('404 on unknown', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/accept-spec' })
    expect(r.statusCode).toBe(404)
    await app.close()
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
        skills: ['s1'],
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
        skills: ['s1'],
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

  it('uses loadSkillContent if provided', async () => {
    let loaded: string[] = []
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
      spawnSpecAgent: async () => '<file path="x.ts">x</file>',
      loadSkillContent: (id) => {
        loaded.push(id)
        return `body of ${id}`
      },
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'app', localPath: '/p' }],
        skills: ['skill-a', 'skill-b'],
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(loaded).toEqual(['skill-a', 'skill-b'])
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
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/reject` })
    expect(r.statusCode).toBe(204)
    expect(readDraft(logsDir, id)?.status).toBe('rejected')
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

describe('GET /api/tests/draft/:id/files/*', () => {
  async function seedDraftWithFile(
    app: ReturnType<typeof Fastify>,
    deps: TestsDraftRouteDeps,
  ): Promise<string> {
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const gen = path.join(deps.logsDir, 'drafts', id, 'generated', 'tests')
    fs.mkdirSync(gen, { recursive: true })
    fs.writeFileSync(path.join(gen, 'login.spec.ts'), 'test("ok",()=>{})')
    return id
  }

  it('returns 200 with file content for a valid path', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = await seedDraftWithFile(app, deps)
    const r = await app.inject({
      method: 'GET',
      url: `/api/tests/draft/${id}/files/tests/login.spec.ts`,
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.content).toBe('test("ok",()=>{})')
    expect(body.mime).toBe('text/plain')
    expect(body.path).toBe('tests/login.spec.ts')
    await app.close()
  })

  it('404s on unknown draft', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'GET', url: '/api/tests/draft/nope/files/x.ts' })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('404s on missing file inside draft', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = await seedDraftWithFile(app, deps)
    const r = await app.inject({
      method: 'GET',
      url: `/api/tests/draft/${id}/files/does/not/exist.ts`,
    })
    expect(r.statusCode).toBe(404)
    await app.close()
  })

  it('400s when the request path is empty', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = await seedDraftWithFile(app, deps)
    const r = await app.inject({
      method: 'GET',
      url: `/api/tests/draft/${id}/files/`,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('invalid path')
    await app.close()
  })

  it('400s on traversal (percent-encoded so URL parser does not normalise)', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = await seedDraftWithFile(app, deps)
    // Inject with a fully encoded `..` so neither HTTP nor Fastify collapses
    // the segment before our handler sees it.
    const r = await app.inject({
      method: 'GET',
      url: `/api/tests/draft/${id}/files/sub/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd`,
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})
