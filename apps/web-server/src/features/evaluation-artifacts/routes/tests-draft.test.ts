import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRef } from '../../agent-management/logic/agent-session-log'

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
  type TestsDraftRouteDeps,
} from './tests-draft'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
} from '../logic/wizard-agent-spawner'
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

describe('GET /api/tests/draft/:id/agent-session', () => {
  it('does not return a saved session log that predates the current draft stage', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    const p = draftPaths(logsDir, id)
    const oldLogPath = path.join(p.draftDir, 'old-session.jsonl')
    fs.writeFileSync(oldLogPath, '{}\n')
    fs.utimesSync(oldLogPath, new Date('2026-05-15T23:59:00.000Z'), new Date('2026-05-15T23:59:00.000Z'))
    writeDraft(logsDir, {
      ...rec,
      wizardAgent: 'claude',
      planAgentSpawnedAt: '2026-05-16T00:00:00.000Z',
      planAgentSessionRef: { agent: 'claude', sessionId: 'old-session', logPath: oldLogPath },
    })

    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-session?stage=planning` })

    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ reason: 'no-session-ref' })
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
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
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
      spawnSpecAgent: async () => {
        specCalled++
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
      spawnPlanAgent: async () => `<plan-output>[
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
    // claude pins its session id during planning; the spec stage resumes that
    // exact (generated) id — not a hardcoded value.
    const expectedResume = readDraft(logsDir, id)!.planAgentSessionId
    expect(expectedResume).toBeTruthy()
    const r = await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: { plan: editedPlan },
    })
    expect(r.statusCode).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    expect(specInput?.resumeSessionId).toBe(expectedResume)
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
        return fileBlocks(buildFeatureScaffold({ featureName: 'login', description: 'Login flow' }).map((file) => (
          file.path === 'e2e/login.spec.ts'
            ? { ...file, content: "import { test } from 'canary-lab/feature-support/log-marker-fixture';\ntest('x', async () => {});\n" }
            : file
        )))
      },
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login flow',
        repos: [{ name: 'app', localPath: '/p' }],
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
    expect(fs.readFileSync(path.join(featureDir, 'playwright.config.ts'), 'utf8')).toContain('baseConfig')
    expect(fs.readFileSync(path.join(featureDir, 'e2e/login.spec.ts'), 'utf8')).toContain("test('x'")
    expect(walkRelative(featureDir)).toEqual([...canonicalScaffoldPaths('login'), 'docs/intent.md'].sort())
    expect(fs.existsSync(path.join(featureDir, '.canary-lab-draft-id'))).toBe(false)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('accepted')
    await app.close()
  })

  it('preserves uploaded originals and additional notes under feature docs once', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'context_docs' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: '# Pasted PRD\n\nKeep checkout steps strict',
        additionalNotes: 'Keep checkout steps strict',
        prdDocuments: [
          {
            filename: 'command.md',
            contentType: 'text/markdown',
            characters: 15,
            text: 'Command guidance',
            contentBase64: Buffer.from('# Command\n').toString('base64'),
          },
          {
            filename: 'cresclaben.md',
            contentType: 'text/markdown',
            characters: 18,
            text: 'Cresclaben notes',
            contentBase64: Buffer.from('# Cresclaben\n').toString('base64'),
          },
        ],
        repos: [{ name: 'app', localPath: '/p' }],
        featureName: 'context_docs',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(200)
    const featureDir = path.join(projectRoot, 'features', 'context_docs')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'additional-notes.md'), 'utf8')).toContain('Keep checkout steps strict')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'command.md'), 'utf8')).toBe('# Command\n')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'cresclaben.md'), 'utf8')).toBe('# Cresclaben\n')
    expect(walkRelative(path.join(featureDir, 'docs'))).toEqual([
      'additional-notes.md',
      'command.md',
      'cresclaben.md',
      'intent.md',
    ])
    const rec = readDraft(logsDir, id)!
    const generatedDocs = (rec.generatedFiles ?? [])
      .map((file) => path.relative(featureDir, file))
      .filter((file) => file.startsWith('docs/'))
      .sort()
    expect(generatedDocs).toEqual([
      'docs/additional-notes.md',
      'docs/command.md',
      'docs/cresclaben.md',
      'docs/intent.md',
    ])
    await app.close()
  })

  it('writes docs/intent.md with the user-edited intent summary on accept-spec', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<intent-summary>
Agent-produced intent summary.
</intent-summary>
<plan-output>[
  {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'intent_feature' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Login',
        repos: [{ name: 'app', localPath: '/p' }],
        featureName: 'intent_feature',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({
      method: 'POST',
      url: `/api/tests/draft/${id}/accept-plan`,
      payload: { intentSummary: 'User-edited intent text.' },
    })
    await new Promise((r) => setTimeout(r, 20))
    const accept = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(accept.statusCode).toBe(200)
    const featureDir = path.join(projectRoot, 'features', 'intent_feature')
    const intentBody = fs.readFileSync(path.join(featureDir, 'docs', 'intent.md'), 'utf8')
    expect(intentBody).toBe('# Intent summary\n\nUser-edited intent text.\n')
    await app.close()
  })

  it('preserves same-name uploads with deterministic suffixes before the extension', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async () => fileBlocks(buildFeatureScaffold({ featureName: 'collision_docs' })),
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: '# Pasted PRD',
        prdDocuments: [
          {
            filename: 'command.md',
            contentType: 'text/markdown',
            characters: 5,
            contentBase64: Buffer.from('first').toString('base64'),
          },
          {
            filename: 'command.md',
            contentType: 'text/markdown',
            characters: 6,
            contentBase64: Buffer.from('second').toString('base64'),
          },
        ],
        repos: [{ name: 'app', localPath: '/p' }],
        featureName: 'collision_docs',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(200)
    const featureDir = path.join(projectRoot, 'features', 'collision_docs')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'command.md'), 'utf8')).toBe('first')
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'command-2.md'), 'utf8')).toBe('second')
    expect(walkRelative(path.join(featureDir, 'docs'))).toEqual(['command-2.md', 'command.md', 'intent.md'])
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
      spawnSpecAgent: async () => `${fileBlocks(buildFeatureScaffold({ featureName: 'deps' }).map((file) => (
        file.path === 'e2e/deps.spec.ts'
          ? { ...file, content: "import { test } from 'canary-lab/feature-support/log-marker-fixture'\nimport amqplib from 'amqplib'\ntest('x', async () => { void amqplib })\n" }
          : file
      )))}
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
      spawnSpecAgent: async () => `${fileBlocks(buildFeatureScaffold({ featureName: 'badpkg' }))}
<dev-dependencies>["mysql2"]</dev-dependencies>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Bad package',
        repos: [{ name: 'app', localPath: '/p' }],
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

  it('rejects malformed scaffold output before writing feature files', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"Open","actions":["go"],"expectedOutcome":"visible"}
      ]</plan-output>`,
      spawnSpecAgent: async () => `<file path="feature.config.cjs">
const config = { name: 'badscaffold' }
module.exports = { config }
</file>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'Bad scaffold',
        repos: [{ name: 'app', localPath: '/p' }],
        featureName: 'badscaffold',
      },
    })
    const id = post.json().draftId
    await new Promise((r) => setTimeout(r, 20))
    await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    await new Promise((r) => setTimeout(r, 20))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid-scaffold')
    expect(fs.existsSync(path.join(projectRoot, 'features', 'badscaffold'))).toBe(false)
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

function walkRelative(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else {
        out.push(path.relative(root, full))
      }
    }
  }
  visit(root)
  return out.sort()
}

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

  it('400s with the outside-draft message via the defence-in-depth guard', async () => {
    // The resolver never emits outside-draft from route input (`..` and leading
    // slashes are rejected first), so force its defence-in-depth reason to cover
    // the route's handling.
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = await seedDraftWithFile(app, deps)
    resolveDraftFileOverride = () => ({ ok: false, reason: 'outside-draft' })
    const r = await app.inject({
      method: 'GET',
      url: `/api/tests/draft/${id}/files/tests/login.spec.ts`,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'path resolves outside draft' })
    await app.close()
  })
})

describe('POST /api/tests/prd-documents', () => {
  it('400s when the request is not multipart', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/prd-documents',
      payload: { prdText: 'hello' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'multipart form data required' })
    await app.close()
  })

  it('combines pasted text and uploaded documents into prdText', async () => {
    const app = await makeApp(makeDeps())
    const boundary = '----canaryboundary'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="prdText"',
      '',
      'Pasted requirements line',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="spec.md"',
      'Content-Type: text/markdown',
      '',
      '# Heading\n\nUploaded body content',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/prd-documents',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(r.statusCode).toBe(200)
    const json = r.json()
    expect(json.prdText).toContain('Pasted requirements line')
    expect(json.prdText).toContain('Uploaded body content')
    expect(json.documents).toHaveLength(1)
    expect(json.documents[0]).toMatchObject({ filename: 'spec.md', contentType: 'text/markdown' })
    expect(json.documents[0].contentBase64).toBe(Buffer.from('# Heading\n\nUploaded body content').toString('base64'))
    await app.close()
  })

  it('400s with the extractor message when a document type is unsupported', async () => {
    const app = await makeApp(makeDeps())
    const boundary = '----canaryboundary'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="image.bin"',
      'Content-Type: application/octet-stream',
      '',
      'binarydata',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/prd-documents',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toContain('Unsupported PRD file type')
    await app.close()
  })

  it('400s when no pasted text and no documents yield PRD text', async () => {
    const app = await makeApp(makeDeps())
    const boundary = '----canaryboundary'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="prdText"',
      '',
      '   ',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/prd-documents',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ error: 'PRD text required' })
    await app.close()
  })

  it('ignores non-string and unrelated fields while combining', async () => {
    const app = await makeApp(makeDeps())
    const boundary = '----canaryboundary'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="other"',
      '',
      'ignored value',
      `--${boundary}`,
      'Content-Disposition: form-data; name="prdText"',
      '',
      'Real prd body',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/prd-documents',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().prdText).toContain('Real prd body')
    await app.close()
  })
})

describe('GET /api/tests/draft/:id/agent-session (404 paths)', () => {
  it('404s when the draft does not exist', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'GET', url: '/api/tests/draft/nope/agent-session?stage=planning' })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ reason: 'draft-not-found' })
    await app.close()
  })

  it('400s on an unknown stage', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-session?stage=refining` })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({ reason: 'unknown-stage' })
    await app.close()
  })

  it('returns the parsed session events when the log exists', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    const p = draftPaths(logsDir, id)
    const logPath = path.join(p.draftDir, 'live-session.jsonl')
    fs.writeFileSync(logPath, '')
    writeDraft(logsDir, {
      ...rec,
      wizardAgent: 'claude',
      planAgentSpawnedAt: '2026-05-15T00:00:00.000Z',
      planAgentSessionRef: { agent: 'claude', sessionId: 'live-session', logPath },
    })
    fs.utimesSync(logPath, new Date('2026-05-16T00:00:00.000Z'), new Date('2026-05-16T00:00:00.000Z'))

    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-session?stage=planning` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ agent: 'claude', sessionId: 'live-session', events: [] })
    await app.close()
  })

  it('404s session-log-missing when the ref resolves but the file is gone', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    const p = draftPaths(logsDir, id)
    const logPath = path.join(p.draftDir, 'never-written.jsonl')
    writeDraft(logsDir, {
      ...rec,
      wizardAgent: 'claude',
      specAgentSpawnedAt: '2026-05-15T00:00:00.000Z',
      specAgentSessionRef: { agent: 'claude', sessionId: 'never-written', logPath },
    })
    // The real resolver only hands back refs whose log existed at resolution
    // time; the gap before the route stats the file is a TOCTOU race. Force the
    // race deterministically via a one-shot resolver override.
    resolveSessionRefOverride = () => ({ agent: 'claude', sessionId: 'never-written', logPath })

    const r = await app.inject({ method: 'GET', url: `/api/tests/draft/${id}/agent-session?stage=generating` })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ reason: 'session-log-missing' })
    await app.close()
  })
})

describe('POST /api/tests/draft/:id/cancel-generation (404)', () => {
  it('404s when the draft does not exist', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/cancel-generation' })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'draft not found' })
    await app.close()
  })
})

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

describe('cancellation races inside pipeline drivers', () => {
  it('runPlanStage bails out when the agent throws after the run was cancelled', async () => {
    const deps = makeDeps({
      spawnPlanAgent: async ({ draftId }) => {
        // Cancel the draft, then throw — isCancelled() must short-circuit the
        // error transition.
        const rec = readDraft(logsDir, draftId)!
        writeDraft(logsDir, { ...rec, status: 'cancelled' })
        throw new Error('late failure')
      },
    })
    await runPlanStage(deps, await seedPlanningDraft(deps))
    // Re-read: status stays cancelled, no error transition.
    const id = fs.readdirSync(path.join(logsDir, 'drafts'))[0]
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
    expect(readDraft(logsDir, id)!.errorMessage).toBeUndefined()
  })

  it('runSpecStage bails out when the agent throws after the run was cancelled', async () => {
    const deps = makeDeps({
      spawnSpecAgent: async ({ draftId }) => {
        const rec = readDraft(logsDir, draftId)!
        writeDraft(logsDir, { ...rec, status: 'cancelled' })
        throw new Error('late spec failure')
      },
    })
    const id = await seedGeneratingDraft(deps)
    await runSpecStage(deps, id)
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
    expect(readDraft(logsDir, id)!.errorMessage).toBeUndefined()
  })

  it('runSpecStage discards output produced after cancellation', async () => {
    const deps = makeDeps({
      spawnSpecAgent: async ({ draftId }) => {
        const rec = readDraft(logsDir, draftId)!
        writeDraft(logsDir, { ...rec, status: 'cancelled' })
        return '<file path="feature.config.cjs">x</file>'
      },
    })
    const id = await seedGeneratingDraft(deps)
    await runSpecStage(deps, id)
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
    expect(fs.existsSync(path.join(logsDir, 'drafts', id, 'generated'))).toBe(false)
  })

  it('runPlanStage stops when the draft leaves planning during the patch publish', async () => {
    // The injected workspace-events publisher cancels the draft synchronously
    // during patchDraft, so isStageCurrent('planning') is false afterwards and
    // the spawner is never invoked.
    const spawnPlanAgent = vi.fn(async () => '<plan-output>[]</plan-output>')
    let cancelOnNextPublish = false
    const deps = makeDeps({
      spawnPlanAgent,
      workspaceEvents: {
        publish: (event: { type: string; draft?: { draftId: string } }) => {
          if (cancelOnNextPublish && event.type === 'draft-updated' && event.draft) {
            cancelOnNextPublish = false
            const rec = readDraft(logsDir, event.draft.draftId)!
            if (rec.status === 'planning') {
              writeDraft(logsDir, { ...rec, status: 'cancelled' })
            }
          }
        },
      } as unknown as TestsDraftRouteDeps['workspaceEvents'],
    })
    const id = await seedPlanningDraft(deps)
    cancelOnNextPublish = true
    await runPlanStage(deps, id)
    expect(spawnPlanAgent).not.toHaveBeenCalled()
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
  })

  it('runSpecStage stops when the draft leaves generating during the patch publish', async () => {
    const spawnSpecAgent = vi.fn(async () => '<file path="feature.config.cjs">x</file>')
    let cancelOnNextPublish = false
    const deps = makeDeps({
      spawnSpecAgent,
      workspaceEvents: {
        publish: (event: { type: string; draft?: { draftId: string } }) => {
          if (cancelOnNextPublish && event.type === 'draft-updated' && event.draft) {
            cancelOnNextPublish = false
            const rec = readDraft(logsDir, event.draft.draftId)!
            if (rec.status === 'generating') {
              writeDraft(logsDir, { ...rec, status: 'cancelled' })
            }
          }
        },
      } as unknown as TestsDraftRouteDeps['workspaceEvents'],
    })
    const id = await seedGeneratingDraft(deps)
    cancelOnNextPublish = true
    await runSpecStage(deps, id)
    expect(spawnSpecAgent).not.toHaveBeenCalled()
    expect(readDraft(logsDir, id)!.status).toBe('cancelled')
  })
})

async function seedPlanningDraft(deps: TestsDraftRouteDeps): Promise<string> {
  // Build a planning draft without firing runPlanStage (we drive it directly).
  const id = `seed-plan-${++counter}`
  const { createDraft, transition } = await import('../logic/draft-store')
  createDraft(logsDir, { draftId: id, prdText: 'seed', repos: [{ name: 'app', localPath: '/p' }] })
  transition(logsDir, id, 'planning')
  void deps
  return id
}

async function seedGeneratingDraft(deps: TestsDraftRouteDeps): Promise<string> {
  const id = `seed-gen-${++counter}`
  const { createDraft, transition } = await import('../logic/draft-store')
  createDraft(logsDir, { draftId: id, prdText: 'seed', repos: [{ name: 'app', localPath: '/p' }] })
  transition(logsDir, id, 'planning')
  transition(logsDir, id, 'plan-ready', { plan: [{ step: 'x', actions: ['a'], expectedOutcome: 'y' }] })
  transition(logsDir, id, 'generating')
  void deps
  return id
}

describe('pipeline-driver guard branches', () => {
  it('runSpecStage no-ops when the draft is not in generating status', async () => {
    const spawnSpecAgent = vi.fn(async () => '<file path="feature.config.cjs">x</file>')
    const deps = makeDeps({ spawnSpecAgent })
    const id = `not-generating-${++counter}`
    const { createDraft, transition } = await import('../logic/draft-store')
    createDraft(logsDir, { draftId: id, prdText: 'x', repos: [{ name: 'a', localPath: '/' }] })
    transition(logsDir, id, 'planning')
    transition(logsDir, id, 'plan-ready', { plan: [] })
    // Status is plan-ready, not generating — runSpecStage must bail immediately.
    await runSpecStage(deps, id)
    expect(spawnSpecAgent).not.toHaveBeenCalled()
    expect(readDraft(logsDir, id)!.status).toBe('plan-ready')
  })

  it('runPlanStage patchDraft bails when the draft is deleted mid-flight', async () => {
    const id = `deleted-mid-${++counter}`
    const { createDraft, transition, deleteDraft } = await import('../logic/draft-store')
    const deps = makeDeps({
      // pickAgent runs after the initial readDraft but before patchDraft; delete
      // the draft here so patchDraft's own readDraft returns null.
      pickAgent: () => {
        deleteDraft(logsDir, id)
        return { ok: true, agent: 'claude' }
      },
    })
    createDraft(logsDir, { draftId: id, prdText: 'x', repos: [{ name: 'a', localPath: '/' }] })
    transition(logsDir, id, 'planning')
    await runPlanStage(deps, id)
    // Draft stays deleted; patchDraft wrote nothing.
    expect(readDraft(logsDir, id)).toBeNull()
  })
})

describe('fire-and-forget rejection handlers', () => {
  it('POST /draft swallows a runPlanStage rejection (pickAgent throws)', async () => {
    // pickAgent throwing escapes runPlanStage's internal guards, so the promise
    // rejects and the route's `.catch()` handler runs.
    const deps = makeDeps({
      pickAgent: () => { throw new Error('pick exploded') },
    })
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    // The request still succeeds; the rejection is handled out-of-band.
    expect(r.statusCode).toBe(201)
    const id = r.json().draftId
    await new Promise((resolve) => setTimeout(resolve, 10))
    // No error transition (the throw escaped before the error handler), draft
    // remains in planning.
    expect(readDraft(logsDir, id)!.status).toBe('planning')
    await app.close()
  })

  it('accept-plan swallows a runSpecStage rejection (pickAgent throws at spec)', async () => {
    let calls = 0
    const deps = makeDeps({
      pickAgent: () => {
        calls += 1
        if (calls === 1) return { ok: true, agent: 'claude' }
        throw new Error('spec pick exploded')
      },
      spawnPlanAgent: async () => `<plan-output>[
        {"step":"X","actions":["a"],"expectedOutcome":"y"}
      ]</plan-output>`,
    })
    const app = await makeApp(deps)
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
    await new Promise((resolve) => setTimeout(resolve, 10))
    const accept = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-plan`, payload: {} })
    expect(accept.statusCode).toBe(202)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The spec rejection was swallowed; draft stays generating (no error
    // transition because the throw escaped the error handler).
    expect(readDraft(logsDir, id)!.status).toBe('generating')
    await app.close()
  })
})

describe('helper-level branches', () => {
  it('runSpecStage handles a draft with empty repos via defaultFeatureName', async () => {
    // Drive runSpecStage on a hand-written record with no repos and a prdText
    // that slugifies to untitled-feature, exercising defaultFeatureName's
    // missing-repo fallback branch.
    const captured: string[] = []
    const deps = makeDeps({
      spawnSpecAgent: async (input) => {
        captured.push(input.featureName)
        return '<file path="feature.config.cjs">x</file>'
      },
    })
    const id = `no-repo-${++counter}`
    const { createDraft, transition } = await import('../logic/draft-store')
    createDraft(logsDir, { draftId: id, prdText: '!!!', repos: [{ name: 'app', localPath: '/p' }] })
    transition(logsDir, id, 'planning')
    transition(logsDir, id, 'plan-ready', { plan: [] })
    transition(logsDir, id, 'generating')
    // Strip repos after reaching generating so the transition guards still pass.
    const rec = readDraft(logsDir, id)!
    writeDraft(logsDir, { ...rec, repos: [] })

    await runSpecStage(deps, id)
    expect(captured[0]).toBe('untitled-feature')
  })

  it('isDraftPrdDocument ignores non-object entries in prdDocuments', async () => {
    // A null/non-object entry exercises the early `!value` guard; it is filtered
    // out so the resulting draft keeps only the valid document.
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: {
        prdText: 'X',
        repos: [{ name: 'a', localPath: '/' }],
        prdDocuments: [
          null,
          'not-an-object',
          { filename: 'ok.md', contentType: 'text/markdown', characters: 3 },
        ],
      },
    })
    const id = post.json().draftId
    const rec = readDraft(logsDir, id)!
    expect(rec.prdDocuments).toHaveLength(1)
    expect(rec.prdDocuments[0].filename).toBe('ok.md')
    await app.close()
  })

  it('accept-spec writes no docs/intent.md when there is no intent summary, and skips/sanitises uploads', async () => {
    // Hand-build a spec-ready draft so we control prdDocuments precisely:
    //  - one doc without contentBase64 (skipped by writeUploadedDocumentCopies)
    //  - one doc whose filename sanitises to 'document' (safeUploadedFilename)
    //  - no intentSummary (intentSummaryDocForDraft returns [])
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = `spec-ready-${++counter}`
    const { createDraft, transition } = await import('../logic/draft-store')
    createDraft(logsDir, {
      draftId: id,
      prdText: 'X',
      repos: [{ name: 'app', localPath: '/p' }],
      featureName: 'helper_docs',
      prdDocuments: [
        { filename: 'skipme.md', contentType: 'text/markdown', characters: 1 },
        { filename: '..', contentType: 'text/markdown', characters: 5, contentBase64: Buffer.from('safe').toString('base64') },
      ],
    })
    transition(logsDir, id, 'planning')
    transition(logsDir, id, 'plan-ready', { plan: [] })
    transition(logsDir, id, 'generating')
    transition(logsDir, id, 'spec-ready')
    // Seed the generated scaffold on disk so readGeneratedFiles + walk pick it up.
    const p = draftPaths(logsDir, id)
    for (const file of buildFeatureScaffold({ featureName: 'helper_docs' })) {
      const target = path.join(p.generatedDir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    // A dangling symlink is neither a directory nor a regular file, so walk()
    // must skip it (the else-of-isFile branch).
    fs.symlinkSync('nonexistent-target', path.join(p.generatedDir, 'dangling-link'))

    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    expect(r.statusCode).toBe(200)
    const featureDir = path.join(projectRoot, 'features', 'helper_docs')
    // No intent summary => no docs/intent.md written from the draft.
    expect(fs.existsSync(path.join(featureDir, 'docs', 'intent.md'))).toBe(false)
    // skipme.md had no base64 => not copied.
    expect(fs.existsSync(path.join(featureDir, 'docs', 'skipme.md'))).toBe(false)
    // '..' filename sanitised to 'document'.
    expect(fs.readFileSync(path.join(featureDir, 'docs', 'document'), 'utf8')).toBe('safe')
    await app.close()
  })

  it('accept-spec succeeds when no generated directory exists (readGeneratedFiles returns [])', async () => {
    // No generated/ dir at all: readGeneratedFiles short-circuits to []. The
    // accepted scaffold then comes entirely from a provided featureName plus a
    // single uploaded doc that satisfies the spec-file requirement.
    const deps = makeDeps()
    const app = await makeApp(deps)
    const id = `no-generated-${++counter}`
    const { createDraft, transition } = await import('../logic/draft-store')
    createDraft(logsDir, {
      draftId: id,
      prdText: 'X',
      repos: [{ name: 'app', localPath: '/p' }],
      featureName: 'nogen',
      intentSummary: 'a summary',
    })
    transition(logsDir, id, 'planning')
    transition(logsDir, id, 'plan-ready', { plan: [] })
    transition(logsDir, id, 'generating')
    transition(logsDir, id, 'spec-ready')
    // Intentionally do NOT create the generated/ directory.
    expect(fs.existsSync(draftPaths(logsDir, id).generatedDir)).toBe(false)
    const r = await app.inject({ method: 'POST', url: `/api/tests/draft/${id}/accept-spec`, payload: {} })
    // readGeneratedFiles returned [] without throwing on the missing directory;
    // the only assembled file is docs/intent.md, so scaffold validation rejects
    // it as an invalid scaffold (no spec/config files).
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('invalid-scaffold')
    await app.close()
  })
})
