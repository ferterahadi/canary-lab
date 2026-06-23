import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { evaluationRoutes } from './evaluation'
import { createRegistry, RunStore } from '../../runs/logic/run-store'
import { createEvaluationExportTask, evaluationExportsDir } from '../logic/evaluation-export-store'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

let tmpDir: string
let logsDir: string
let featuresDir: string

beforeEach(() => {
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
    expect(body).toContain('<p class="eyebrow">Test Results</p>')
    expect(body).toContain('<h1 id="evaluation-report">Checkout</h1>')
    expect(body).toContain('Test Cases')
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

  it('dismisses completed evaluation export tasks', async () => {
    writeManifestForRun('r-task-dismiss', 'checkout', 'passed')
    const { app } = await build()

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-dismiss/evaluation-export',
      payload: { mode: 'raw' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}`,
    })
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}`,
    })

    expect(deleted.statusCode).toBe(204)
    expect(fetched.statusCode).toBe(404)
  })

  it('cancels running evaluation export tasks when dismissed', async () => {
    writeManifestForRun('r-task-cancel', 'checkout', 'passed')
    let aborted = false
    const generateEvaluationRewrite = vi.fn((_detail, _adapter, _projectRoot, options) => new Promise<null>((resolve) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
        resolve(null)
      }, { once: true })
    }))
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-cancel/evaluation-export',
      payload: { mode: 'localized' },
    })
    const taskId = started.json().taskId
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    })

    expect(deleted.statusCode).toBe(204)
    expect(aborted).toBe(true)
    expect(fetched.statusCode).toBe(404)
  })

  it('exposes failed evaluation export tasks with an error', async () => {
    writeManifestForRun('r-task-failed', 'checkout', 'passed')
    const artifactsDir = path.join(runDirFor(logsDir, 'r-task-failed'), 'playwright-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const unreadableVideo = path.join(artifactsDir, 'blocked.webm')
    fs.writeFileSync(unreadableVideo, 'video')
    fs.chmodSync(unreadableVideo, 0)
    const { app } = await build()

    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/runs/r-task-failed/evaluation-export',
        payload: { mode: 'raw' },
      })

      const task = await waitForEvaluationTask(app, started.json().taskId)
      expect(task.status).toBe('failed')
      expect(task.downloadReady).toBe(false)
      expect(task.error).toBeTruthy()
    } finally {
      fs.chmodSync(unreadableVideo, 0o644)
    }
  })

  it('rejects evaluation export task requests for missing, active, or invalid-mode runs', async () => {
    writeManifestForRun('r-active-task', 'checkout', 'running')
    const { app } = await build()

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/missing/evaluation-export',
      payload: { mode: 'raw' },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/r-active-task/evaluation-export',
      payload: { mode: 'raw' },
    })).statusCode).toBe(409)
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/runs/r-active-task/evaluation-export',
      payload: { mode: 'invalid' },
    })
    expect(invalid.statusCode).toBe(409)

    writeManifestForRun('r-invalid-mode', 'checkout', 'passed')
    const invalidMode = await app.inject({
      method: 'POST',
      url: '/api/runs/r-invalid-mode/evaluation-export',
      payload: { mode: 'invalid' },
    })
    expect(invalidMode.statusCode).toBe(400)
  })

  it('returns not found for unknown evaluation export tasks', async () => {
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/evaluation-exports/missing' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/evaluation-exports/missing/download' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/evaluation-exports/missing' })).statusCode).toBe(404)
  })

  it('marks persisted running evaluation export tasks as failed when no worker owns them', async () => {
    const events: WorkspaceEvent[] = []
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-stale-task',
      runId: 'r-stale-task',
      feature: 'checkout',
      mode: 'raw',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'canary-lab-evaluation-checkout-r-stale-task',
    })
    const { app } = await build({ events })

    const listed = await app.inject({ method: 'GET', url: '/api/evaluation-exports' })
    const fetched = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-stale-task' })

    expect(listed.json()[0]).toMatchObject({
      taskId: 'eval-stale-task',
      status: 'failed',
      downloadReady: false,
      error: 'evaluation export interrupted; start a new export',
    })
    expect(fetched.json()).toMatchObject({ status: 'failed' })
    expect(fs.readFileSync(path.join(evaluationExportsDir(logsDir), 'eval-stale-task', 'export.log'), 'utf8')).toContain('interrupted')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'evaluation-export-updated',
      task: expect.objectContaining({ taskId: 'eval-stale-task', status: 'failed' }),
    }))
  })

  it('keeps running external evaluation export tasks pending across refresh', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-external-pending',
      runId: 'r-external-pending',
      feature: 'checkout',
      mode: 'localized',
      producer: 'external',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'canary-lab-evaluation-checkout-r-external-pending',
      clientKind: 'codex',
      sessionId: 'sess-export',
      conversationName: 'Export evaluation',
      language: 'English',
    })
    const { app } = await build()

    const listed = await app.inject({ method: 'GET', url: '/api/evaluation-exports' })
    const fetched = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-external-pending' })

    expect(listed.json()[0]).toMatchObject({
      taskId: 'eval-external-pending',
      producer: 'external',
      status: 'running',
      downloadReady: false,
      clientKind: 'codex',
      sessionId: 'sess-export',
    })
    expect(fetched.json()).toMatchObject({ status: 'running', producer: 'external' })
  })

  it('completes localized tasks with fallback wording when no rewrite is generated', async () => {
    writeManifestForRun('!!!', '???', 'passed')
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => null,
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/!!!/evaluation-export',
      payload: { mode: 'localized' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)
    const download = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    })

    expect(task.status).toBe('completed')
    expect(download.headers['content-disposition']).toContain('canary-lab-evaluation-run-run.zip')
    expect(fs.readFileSync(path.join(runDirFor(logsDir, '!!!'), 'evaluation-rewrite-error.txt'), 'utf-8')).toContain('No evaluation rewrite was generated')
  })

  it('records string failures from localized evaluation export tasks', async () => {
    writeManifestForRun('r-task-string-failed', 'checkout', 'passed')
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => { throw 'string failure' },
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-string-failed/evaluation-export',
      payload: { mode: 'localized' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    expect(task.status).toBe('completed')
    expect(fs.readFileSync(path.join(runDirFor(logsDir, 'r-task-string-failed'), 'evaluation-rewrite-error.txt'), 'utf-8')).toContain('string failure')
  })

  it('404s when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/missing/evaluation.html' })
    expect(res.statusCode).toBe(404)
  })

  it('409s while the run is still active', async () => {
    writeManifestForRun('r-active', 'checkout', 'running')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r-active/evaluation.html' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('after the run finishes')
  })
})
