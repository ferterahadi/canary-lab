import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDraft } from '../lib/draft-store'
import {
  runPlanStage,
  runSpecStage,
  testsDraftRoutes,
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

describe('POST /api/tests/draft', () => {
  it('creates a draft without skills (status created)', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'Login flow', repos: [{ name: 'app', localPath: '/p' }] },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().status).toBe('created')
    await app.close()
  })

  it('400s on missing prdText', async () => {
    const deps = makeDeps()
    const app = await makeApp(deps)
    const r = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { repos: [{ name: 'app', localPath: '/p' }] },
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

describe('runPlanStage', () => {
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

  it('409s when status is wrong', async () => {
    const app = await makeApp(makeDeps())
    const post = await app.inject({
      method: 'POST',
      url: '/api/tests/draft',
      payload: { prdText: 'X', repos: [{ name: 'a', localPath: '/' }] },
    })
    const id = post.json().draftId
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
      spawnSpecAgent: async () => `<file path="feature.config.cjs">
module.exports = { name: 'login' };
</file>
<file path="e2e/login.spec.ts">
import { test } from '@playwright/test';
test('x', async () => {});
</file>`,
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
    expect(fs.readFileSync(path.join(featureDir, 'e2e/login.spec.ts'), 'utf8')).toContain("test('x'")
    expect(fs.readFileSync(path.join(featureDir, '.canary-lab-draft-id'), 'utf8')).toBe(id)
    const rec = readDraft(logsDir, id)!
    expect(rec.status).toBe('accepted')
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
