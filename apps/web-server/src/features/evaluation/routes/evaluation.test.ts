import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import Fastify from 'fastify'

import { evaluationRoutes } from './evaluation'

import { createRegistry, RunStore } from '../../runs/logic/run-store'

import { createEvaluationExportTask, evaluationExportsDir, patchEvaluationExportTask, readEvaluationExportTask, writeEvaluationExportZip } from '../logic/evaluation-export-store'

import { writeManifest } from '../../runs/logic/runtime/manifest'

import { runDirFor } from '../../runs/logic/runtime/run-paths'

import type { WorkspaceEvent } from '../../../shared/workspace-events'

import { resolveManifestSessionRef, loadAgentSession } from '../../agent-sessions/logic/agent-session-log'

vi.mock('../logic/evaluation-export-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../logic/evaluation-export-store')>()
  return {
    ...original,
    patchEvaluationExportTask: vi.fn(original.patchEvaluationExportTask),
    readEvaluationExportTask: vi.fn(original.readEvaluationExportTask),
    writeEvaluationExportZip: vi.fn(original.writeEvaluationExportZip),
  }
})

vi.mock('../../agent-sessions/logic/agent-session-log', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../agent-sessions/logic/agent-session-log')>()
  return {
    ...original,
    resolveManifestSessionRef: vi.fn(original.resolveManifestSessionRef),
    loadAgentSession: vi.fn(original.loadAgentSession),
  }
})

let tmpDir: string

let logsDir: string

let featuresDir: string

beforeEach(() => {
  vi.mocked(patchEvaluationExportTask).mockClear()
  vi.mocked(readEvaluationExportTask).mockClear()
  vi.mocked(writeEvaluationExportZip).mockClear()
  vi.mocked(resolveManifestSessionRef).mockClear()
  vi.mocked(loadAgentSession).mockClear()
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-evalroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function writeManifestForRun(runId: string, feature = 'foo', status: 'running' | 'passed' | 'failed' | 'healing' | 'aborted' = 'passed'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature,
    featureDir: path.join(featuresDir, feature),
    startedAt: 'now',
    status,
    healCycles: 0,
    services: [],
  })
}

async function build(opts: {
  projectRoot?: string
  generateEvaluationRewrite?: Parameters<typeof evaluationRoutes>[1]['generateEvaluationRewrite']
  events?: WorkspaceEvent[]
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  await app.register(evaluationRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    generateEvaluationRewrite: opts.generateEvaluationRewrite,
    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
  })
  return { app, registry, store }
}

async function waitForEvaluationTask(app: Awaited<ReturnType<typeof build>>['app'], taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await app.inject({ method: 'GET', url: `/api/evaluation-exports/${encodeURIComponent(taskId)}` })
    const body = res.json()
    if (body.status !== 'running') return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`evaluation export task ${taskId} did not finish`)
}

describe('GET /api/runs/:runId/evaluation.html', () => {
  it('exports a completed run as evaluation html with flowcharts in a zip', async () => {
    writeManifestForRun('r-review', 'checkout', 'passed')
    fs.writeFileSync(path.join(runDirFor(logsDir, 'r-review'), 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    }))
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-review/evaluation.html' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/zip')
    expect(res.headers['content-disposition']).toContain('canary-lab-evaluation-checkout-r-review.zip')
    const body = res.rawPayload.toString('latin1')
    expect(body).toContain('evaluation.html')
    expect(body).toContain('<p class="eyebrow">Evaluation report</p>')
    expect(body).toContain('<h1>Checkout</h1>')
    expect(body).toContain('Test cases')
    expect(body).not.toContain('Product Evaluation')
    expect(body).not.toContain('Engineering Evidence')
    expect(body).toContain('class="flowchart"')
    expect(body).not.toContain('test-review.json')
  })

  it('exports evaluation html and retained videos together as a zip', async () => {
    writeManifestForRun('r-review:video', 'checkout', 'passed')
    const spec = path.join(featuresDir, 'checkout', 'e2e', 'checkout.spec.ts')
    fs.mkdirSync(path.dirname(spec), { recursive: true })
    fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'

test('passes checkout', async ({ page }) => {
  await expect(page.getByText('Checkout')).toBeVisible()
})
`)
    fs.writeFileSync(path.join(runDirFor(logsDir, 'r-review:video'), 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    }))
    const video = path.join(runDirFor(logsDir, 'r-review:video'), 'playwright-artifacts', 'case-a', 'recording.webm')
    fs.mkdirSync(path.dirname(video), { recursive: true })
    fs.writeFileSync(video, 'WEBM')
    fs.writeFileSync(
      path.join(runDirFor(logsDir, 'r-review:video'), 'playwright-events.jsonl'),
      JSON.stringify({
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-passes-checkout', title: 'passes checkout', location: `${spec}:3` },
        status: 'passed',
        passed: true,
        durationMs: 12,
        retry: 0,
        attachments: [{ name: 'video', contentType: 'video/webm', path: video }],
      }) + '\n',
    )
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-review%3Avideo/evaluation.html' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/zip')
    expect(res.headers['content-disposition']).toContain('canary-lab-evaluation-checkout-r-review-video.zip')
    const body = res.rawPayload.toString('latin1')
    expect(body).toContain('evaluation.html')
    expect(body).toContain('r-review-video.webm')
    expect(body).toContain('Evaluation flow for Passes checkout')
    expect(body).toContain('<h3>Video</h3>')
    expect(body).toContain('<video controls preload="metadata" src="r-review-video.webm"></video>')
    expect(body.indexOf('<summary>Checks</summary>')).toBeLessThan(body.indexOf('<h3>Video</h3>'))
    expect(body).toContain('WEBM')
  })

  it('exports videos using content-type extensions and ignores unsafe artifact paths', async () => {
    writeManifestForRun('r-videos', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-videos')
    const artifactsDir = path.join(runDir, 'playwright-artifacts')
    const spec = path.join(featuresDir, 'checkout', 'e2e', 'checkout.spec.ts')
    fs.mkdirSync(path.dirname(spec), { recursive: true })
    fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'

test('records checkout', async ({ page }) => {
  await expect(page.getByText('Checkout')).toBeVisible()
})
`)
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-records-checkout'],
      failed: [],
    }))
    for (const rel of ['case-a/recording', 'case-b/recording', 'case-c/raw']) {
      const file = path.join(artifactsDir, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, rel)
    }
    fs.writeFileSync(
      path.join(runDir, 'playwright-events.jsonl'),
      JSON.stringify({
        type: 'test-end',
        time: 't',
        test: { name: 'test-case-records-checkout', title: 'records checkout', location: `${spec}:3` },
        status: 'passed',
        passed: true,
        durationMs: 12,
        retry: 0,
        attachments: [
          { name: 'video', contentType: 'video/mp4', path: path.join(artifactsDir, 'case-a/recording') },
          { name: 'video', contentType: 'video/webm', path: path.join(artifactsDir, 'case-b/recording') },
          { name: 'video', path: path.join(artifactsDir, 'case-c/raw') },
          { name: 'video', contentType: 'video/webm', path: '../outside.webm' },
        ],
      }) + '\n',
    )
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-videos/evaluation.html' })

    expect(res.statusCode).toBe(200)
    const body = res.rawPayload.toString('latin1')
    expect(body).toContain('r-videos-1.mp4')
    expect(body).toContain('r-videos-2.webm')
    expect(body).toContain('r-videos-3.webm')
    expect(body).not.toContain('outside.webm')
  })

  it('uses the configured agent rewrite and caches only the final report wording', async () => {
    writeManifestForRun('r-rewrite', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-rewrite')
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    }))
    fs.writeFileSync(path.join(tmpDir, 'canary-lab.config.json'), JSON.stringify({ healAgent: 'codex' }))
    const generateEvaluationRewrite = async () => ({
      featureTitle: 'Checkout flow for stakeholders',
      summary: 'Readable cached summary.',
      cases: [{
        title: 'Customer can complete checkout',
        whatWasChecked: 'The checkout path completed as expected.',
        whyItMatters: 'Stakeholders can read this without test-code context.',
        confidence: 'Confidence: strong.',
        flowSteps: [
          { title: 'Start checkout scenario' },
          { title: 'Prepare checkout evidence', detail: 'Source was unavailable.' },
          { title: 'Run result: passed' },
        ],
      }],
    })
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-rewrite/evaluation.html' })

    expect(res.statusCode).toBe(200)
    const body = res.rawPayload.toString('latin1')
    expect(body).toContain('evaluation.html')
    expect(body).toContain('Checkout flow for stakeholders')
    expect(body).toContain('Customer can complete checkout')
    expect(body).toContain('Start checkout scenario')
    expect(body).not.toContain('source.html')
    expect(body).not.toContain('rewrite-rules')
    expect(fs.existsSync(path.join(runDir, 'evaluation-rewrite.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'evaluation-rewrite-error.txt'))).toBe(false)
  })

  it('exports fallback report and records rewrite errors when localization fails', async () => {
    writeManifestForRun('r-rewrite-error', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-rewrite-error')
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    }))
    fs.writeFileSync(path.join(tmpDir, 'canary-lab.config.json'), JSON.stringify({ healAgent: 'codex' }))
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => { throw new Error('codex flag unsupported') },
    })

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-rewrite-error/evaluation.html' })

    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.toString('latin1')).toContain('evaluation.html')
    expect(fs.readFileSync(path.join(runDir, 'evaluation-rewrite-error.txt'), 'utf-8')).toContain('codex flag unsupported')
    expect(fs.existsSync(path.join(runDir, 'evaluation-rewrite.json'))).toBe(false)
  })

  it('ignores stale rewrite cache formats and regenerates localized wording', async () => {
    writeManifestForRun('r-stale-rewrite', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-stale-rewrite')
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    }))
    fs.writeFileSync(path.join(runDir, 'evaluation-rewrite.json'), JSON.stringify({
      summary: 'Old technical summary.',
      cases: [{
        title: 'old technical title',
        whatWasChecked: 'old',
        whyItMatters: 'old',
        confidence: 'old',
      }],
    }))
    fs.writeFileSync(path.join(tmpDir, 'canary-lab.config.json'), JSON.stringify({ healAgent: 'codex' }))
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => ({
        featureTitle: 'Regenerated report',
        summary: 'Regenerated readable summary.',
        cases: [{
          title: 'Regenerated readable title',
          whatWasChecked: 'Readable explanation.',
          whyItMatters: 'Readable impact.',
          confidence: 'Readable confidence.',
        }],
      }),
    })

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-stale-rewrite/evaluation.html' })

    expect(res.statusCode).toBe(200)
    const body = res.rawPayload.toString('latin1')
    expect(body).toContain('Regenerated readable title')
    expect(body).not.toContain('old technical title')
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'evaluation-rewrite.json'), 'utf-8')).formatVersion).toBe(6)
  })

  it('keeps the old assertion route as an evaluation export alias', async () => {
    writeManifestForRun('r-alias', 'checkout', 'passed')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r-alias/assertion.html' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('canary-lab-evaluation-checkout-r-alias.zip')
    expect(res.rawPayload.toString('latin1')).toContain('evaluation.html')
  })

  it('runs raw evaluation export tasks without invoking the LLM rewrite', async () => {
    writeManifestForRun('r-task-raw', 'checkout', 'passed')
    const generateEvaluationRewrite = vi.fn()
    const { app } = await build({ generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-raw/evaluation-export',
      payload: { mode: 'raw' },
    })

    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)
    expect(task.status).toBe('completed')
    expect(task.downloadReady).toBe(true)
    expect(generateEvaluationRewrite).not.toHaveBeenCalled()

    const download = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain('canary-lab-evaluation-checkout-r-task-raw.zip')
    expect(download.rawPayload.toString('latin1')).toContain('evaluation.html')
    expect(fs.existsSync(path.join(evaluationExportsDir(logsDir), task.taskId, 'task.json'))).toBe(true)
    expect(fs.readFileSync(path.join(evaluationExportsDir(logsDir), task.taskId, 'export.log'), 'utf8')).toContain('task completed')
    expect(fs.existsSync(path.join(evaluationExportsDir(logsDir), task.taskId, 'export.zip'))).toBe(true)
  })

  it('lists persisted evaluation export tasks and filters by run', async () => {
    writeManifestForRun('r-task-list-a', 'checkout', 'passed')
    writeManifestForRun('r-task-list-b', 'orders', 'passed')
    const { app } = await build()

    const first = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-list-a/evaluation-export',
      payload: { mode: 'raw' },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-list-b/evaluation-export',
      payload: { mode: 'raw' },
    })
    await waitForEvaluationTask(app, first.json().taskId)
    await waitForEvaluationTask(app, second.json().taskId)

    const all = await app.inject({ method: 'GET', url: '/api/evaluation-exports' })
    const filtered = await app.inject({ method: 'GET', url: '/api/evaluation-exports?runId=r-task-list-a' })

    expect(all.statusCode).toBe(200)
    expect(all.json().map((task: { taskId: string }) => task.taskId).sort()).toEqual([first.json().taskId, second.json().taskId].sort())
    expect(filtered.json().map((task: { runId: string }) => task.runId)).toEqual(['r-task-list-a'])
  })

  it('runs localized evaluation export tasks through the rewrite path', async () => {
    writeManifestForRun('r-task-localized', 'checkout', 'passed')
    fs.writeFileSync(path.join(runDirFor(logsDir, 'r-task-localized'), 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['checkout completes'],
      failed: [],
    }))
    const generateEvaluationRewrite = vi.fn(async () => ({
      featureTitle: 'Readable checkout report',
      summary: 'Readable localized summary.',
      cases: [{
        title: 'Readable localized case',
        whatWasChecked: 'Readable check.',
        whyItMatters: 'Readable impact.',
        confidence: 'Readable confidence.',
      }],
    }))
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-localized/evaluation-export',
      payload: { mode: 'localized' },
    })

    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)
    expect(task.status).toBe('completed')
    expect(generateEvaluationRewrite).toHaveBeenCalledTimes(1)

    const download = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.toString('latin1')).toContain('Readable localized summary')
  })

  it('does not allow downloading a task before the export completes', async () => {
    writeManifestForRun('r-task-pending', 'checkout', 'passed')
    const generateEvaluationRewrite = vi.fn(() => new Promise<never>(() => {}))
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-pending/evaluation-export',
      payload: { mode: 'localized' },
    })
    const download = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(started.json().taskId)}/download`,
    })

    expect(download.statusCode).toBe(409)
    expect(download.json().error).toContain('not ready')
  })
})
