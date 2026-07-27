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

describe('POST /api/tests/draft/:id/cancel-generation (404)', () => {
  it('404s when the draft does not exist', async () => {
    const app = await makeApp(makeDeps())
    const r = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/cancel-generation' })
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: 'draft not found' })
    await app.close()
  })
})
