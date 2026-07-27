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
