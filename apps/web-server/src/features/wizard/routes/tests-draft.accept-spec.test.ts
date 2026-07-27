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
