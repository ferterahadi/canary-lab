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
    const id = fs.readdirSync(path.join(logsDir, 'drafts')).filter((n) => n !== 'index.json')[0]
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
    })
    transition(logsDir, id, 'planning')
    transition(logsDir, id, 'plan-ready', { plan: [] })
    transition(logsDir, id, 'generating', { intentSummary: 'a summary' })
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
