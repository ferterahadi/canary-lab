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
