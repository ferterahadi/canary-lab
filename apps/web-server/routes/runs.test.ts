import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike, type RestartHealResult, type RestartRunResult } from '../lib/run-store'
import { createEvaluationExportTask, evaluationExportsDir } from '../lib/evaluation-export-store'
import { readManifest, readRunsIndex, writeManifest, writeRunsIndex } from '../lib/runtime/manifest'
import { runDirFor } from '../lib/runtime/run-paths'
import type { WorkspaceEvent } from '../lib/workspace-events'

let tmpDir: string
let logsDir: string
let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function makeStub(runId: string): OrchestratorLike & { stopped: boolean } {
  let stopped = false
  return {
    runId,
    stop: async () => { stopped = true },
    pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
    cancelHeal: async () => ({ ok: true }),
    get stopped() { return stopped },
  } as OrchestratorLike & { stopped: boolean }
}

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

function writeFeature(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: [], featureDir: __dirname } }`,
  )
}

async function build(opts: {
	  startRun?: (f: string) => Promise<OrchestratorLike>
	  broker?: Parameters<typeof runsRoutes>[1]['broker']
	  restartHeal?: (runId: string, text: string) => Promise<RestartHealResult>
	  restartRun?: (runId: string) => Promise<RestartRunResult>
  projectRoot?: string
  generateEvaluationRewrite?: Parameters<typeof runsRoutes>[1]['generateEvaluationRewrite']
  events?: WorkspaceEvent[]
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    broker: opts.broker,
	    startRun: opts.startRun ?? (async () => { throw new Error('not configured') }),
	    restartHeal: opts.restartHeal,
    restartRun: opts.restartRun,
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

describe('GET /api/runs', () => {
  it('lists runs newest first', async () => {
    writeRunsIndex(logsDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'foo', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.json().map((r: { runId: string }) => r.runId)).toEqual(['b', 'a'])
  })

  it('filters by feature', async () => {
    writeRunsIndex(logsDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'bar', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs?feature=bar' })
    expect(res.json().map((r: { runId: string }) => r.runId)).toEqual(['b'])
  })
})

describe('GET /api/runs/:runId', () => {
  it('returns the manifest', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().runId).toBe('r1')
  })

  it('404s on unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/none' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/runs/:runId/agent-session', () => {
  it('returns normalized events when agent-session.json + log exist', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    // Stand up a fake claude session log on disk.
    const logPath = path.join(tmpDir, 'fake-session.jsonl')
    fs.writeFileSync(logPath, JSON.stringify({
      type: 'user',
      timestamp: 't',
      message: { content: 'hi' },
    }) + '\n')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath,
    }))

    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { agent: string; events: Array<{ kind: string }> }
    expect(body.agent).toBe('claude')
    expect(body.events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'hi' },
    ])
  })

  it('404 reason=run-not-found when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/none/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'run-not-found' })
  })

  it('404 reason=no-session-ref when the pointer file is missing', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'no-session-ref' })
  })

  it('404 reason=session-log-missing when the pointed-at JSONL is gone', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath: path.join(tmpDir, 'never-existed.jsonl'),
    }))
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'session-log-missing' })
  })
})

describe('GET /api/runs/:runId/artifacts/*', () => {
  it('serves files from the run-local Playwright artifact directory', async () => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a', 'test-failed-1.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'PNGDATA')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a/test-failed-1.png' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.body).toBe('PNGDATA')
  })

  it('rejects artifact path traversal', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/..%2Fmanifest.json' })
    expect(res.statusCode).toBe(400)
  })

  it('404s when artifact path is missing or points to a directory', async () => {
    writeManifestForRun('r1')
    const dir = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/missing.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a' })).statusCode).toBe(404)
  })

  it.each([
    ['case.jpg', 'image/jpeg'],
    ['case.jpeg', 'image/jpeg'],
    ['case.webp', 'image/webp'],
    ['case.webm', 'video/webm'],
    ['case.mp4', 'video/mp4'],
    ['trace.zip', 'application/zip'],
    ['raw.bin', 'application/octet-stream'],
  ])('serves %s with %s', async (name, contentType) => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'data')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: `/api/runs/r1/artifacts/${name}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain(contentType)
  })

  it('falls back to the keep dir when the file is only in playwright-artifacts-keep', async () => {
    // After a heal-cycle respawn, Playwright wipes `playwright-artifacts/`.
    // Files that the orchestrator copied into `playwright-artifacts-keep/`
    // must still be reachable via the same artifact URL the indexer minted
    // against the live dir.
    writeManifestForRun('r1')
    const keepFile = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(keepFile), { recursive: true })
    fs.writeFileSync(keepFile, 'KEPT-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('video/webm')
    expect(res.body).toBe('KEPT-WEBM')
  })

  it('prefers the live dir when the same path exists in both', async () => {
    writeManifestForRun('r1')
    const live = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'pw-slug-a', 'video.webm')
    const keep = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(live), { recursive: true })
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(live, 'FRESH-WEBM')
    fs.writeFileSync(keep, 'STALE-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('FRESH-WEBM')
  })

  it('404s when the file is in neither dir', async () => {
    writeManifestForRun('r1')
    // Create both dirs but no matching file.
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts'), { recursive: true })
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep'), { recursive: true })
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(404)
  })
})

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
      clientKind: 'codex-cli',
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
      clientKind: 'codex-cli',
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

describe('POST /api/runs', () => {
  it('400s when feature missing from body', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('404s when feature is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'ghost' } })
    expect(res.statusCode).toBe(404)
  })

  it('starts a run via the injected factory and registers it', async () => {
    writeFeature('foo')
    const stub = makeStub('run-1')
    const { app, registry } = await build({ startRun: async () => stub })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ runId: 'run-1' })
    expect(registry.get('run-1')).toBe(stub)
  })

  it('400s when env is not in feature.envs', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('rx')
    const { app } = await build({ startRun: async () => stub })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', env: 'staging' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('env must be one of')
  })

  it('accepts a valid env from feature.envs', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('ry')
    let receivedEnv = ''
    const { app } = await build({ startRun: async (_feature, env) => { receivedEnv = env ?? ''; return stub } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', env: 'production' },
    })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBe('production')
  })

  it('defaults to the first declared env', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('rz')
    let receivedEnv = ''
    const { app } = await build({ startRun: async (_feature, env) => { receivedEnv = env ?? ''; return stub } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBe('local')
  })

  it('runs without env when feature declares no envs', async () => {
    const dir = path.join(featuresDir, 'noenv')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'noenv', description: 'd', featureDir: __dirname } }`,
    )
    const stub = makeStub('rno')
    let receivedEnv: string | undefined = 'untouched'
    const { app } = await build({
      startRun: async (_f, env) => { receivedEnv = env; return stub },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'noenv' } })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBeUndefined()
  })

  it('reuses an active external-heal run instead of starting another run', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    const runDir = runDirFor(logsDir, 'active-heal')
    fs.mkdirSync(runDir, { recursive: true })
    writeManifest(path.join(runDir, 'manifest.json'), {
      runId: 'active-heal',
      feature: 'foo',
      featureDir: dir,
      env: 'local',
      startedAt: '2026-05-19T00:00:00.000Z',
      status: 'healing',
      healCycles: 1,
      services: [],
      healMode: 'external',
      lifecycle: {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-19T00:00:01.000Z',
      },
    })
    writeRunsIndex(logsDir, [
      {
        runId: 'active-heal',
        feature: 'foo',
        startedAt: '2026-05-19T00:00:00.000Z',
        status: 'healing',
      },
    ])
    const startRun = vi.fn(async () => makeStub('new-run'))
    const claim = vi.fn(() => ({
      accepted: true as const,
      session: {
        sessionId: 'sess-1',
        clientKind: 'claude-desktop' as const,
        claimedAt: '2026-05-19T00:00:02.000Z',
        lastHeartbeatAt: '2026-05-19T00:00:02.000Z',
        status: 'connected' as const,
        cycleCount: 0,
      },
    }))
    const { app } = await build({ startRun, broker: { claim } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        env: 'local',
        healAgent: {
          kind: 'external',
          sessionId: 'sess-1',
          clientKind: 'claude-desktop',
          conversationName: 'resume run',
        },
        forceNew: true,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      runId: 'active-heal',
      reused: true,
      status: 'healing',
      claimed: true,
      ignoredForceNew: true,
    })
    expect(res.json().warning).toContain('signal_run')
    expect(startRun).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledWith('active-heal', {
      sessionId: 'sess-1',
      clientKind: 'claude-desktop',
      conversationName: 'resume run',
    })
  })

  it('500s with stringified non-Error rejection', async () => {
    writeFeature('foo')
    const { app } = await build({ startRun: async () => { throw 'plain string' } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('plain string')
  })

  it('500s when factory throws', async () => {
    writeFeature('foo')
    const { app } = await build({ startRun: async () => { throw new Error('boom') } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toContain('boom')
  })

  it('preserves typed startRun failure status codes', async () => {
    writeFeature('foo')
    const err = Object.assign(new Error('Repo branch check failed'), { statusCode: 409 })
    const { app } = await build({ startRun: async () => { throw err } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Repo branch check failed')
  })
})

describe('POST /api/runs/:runId/pause-heal', () => {
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/pause-heal' })
    expect(res.statusCode).toBe(404)
  })

  it('202s with failureCount on success', async () => {
    const stub: OrchestratorLike = {
      runId: 'rp1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 3 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rp1', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rp1/pause-heal' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'healing', failureCount: 3 })
  })

  it.each([
    ['already-healing'],
    ['no-playwright-running'],
    ['no-failures-yet'],
  ] as const)('409s with reason=%s', async (reason) => {
    const stub: OrchestratorLike = {
      runId: 'rp2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: false, reason }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rp2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rp2/pause-heal' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/cancel-heal', () => {
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/cancel-heal' })
    expect(res.statusCode).toBe(404)
  })

  it('202s with status=cancelled on success', async () => {
    const stub: OrchestratorLike = {
      runId: 'rc1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 1 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rc1', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rc1/cancel-heal' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'cancelled' })
  })

  it.each([['not-healing'], ['no-agent-running']] as const)('409s with reason=%s', async (reason) => {
    const stub: OrchestratorLike = {
      runId: 'rc2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: false, reason }),
    }
    const { app, registry } = await build()
    registry.set('rc2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rc2/cancel-heal' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/agent-input', () => {
  it('409s when run is not active and cannot restart heal', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ghost/agent-input',
      payload: { data: 'hi\n' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'no-agent-running' })
  })

  it('400s when data is missing or not a string', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('ai1', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai1/agent-input',
      payload: { data: 123 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('409s when no agent is running', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async () => ({ ok: false, reason: 'no-agent-running' }),
    }
    const { app, registry } = await build()
    registry.set('ai2', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai2/agent-input',
      payload: { data: 'hello\n' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'no-agent-running' })
  })

  it('restarts heal when an active orchestrator reports no running agent', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai2b',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async () => ({ ok: false, reason: 'no-agent-running' }),
    }
    let received = { runId: '', text: '' }
    const { app, registry } = await build({
      restartHeal: async (runId, text) => {
        received = { runId, text }
        return { ok: true }
      },
    })
    registry.set('ai2b', stub)

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai2b/agent-input',
      payload: { data: 'resume work' },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted' })
    expect(received).toEqual({ runId: 'ai2b', text: 'resume work' })
  })

  it('202s with status=restarted when a failed stopped run can restart heal', async () => {
    let received = { runId: '', text: '' }
    const { app } = await build({
      restartHeal: async (runId, text) => {
        received = { runId, text }
        return { ok: true }
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/old-failed/agent-input',
      payload: { data: 'try this' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted' })
    expect(received).toEqual({ runId: 'old-failed', text: 'try this' })
  })

  it('500s when a stopped run heal restart fails to spawn', async () => {
    const { app } = await build({
      restartHeal: async () => ({ ok: false, reason: 'spawn-failed' }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/spawn-failed/agent-input',
      payload: { data: 'try again' },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ reason: 'spawn-failed' })
  })

  // The old `no-session-id` case came from kill+respawn interject. With the
  // bidirectional REPL, active-run interject is just a stdin write, so the only
  // structured active-agent failure left is `no-agent-running`.

  it('409s when interjectHealAgent is undefined (manual mode)', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai3',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('ai3', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai3/agent-input',
      payload: { data: 'hello\n' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('202s with status=sent on success', async () => {
    let received = ''
    const stub: OrchestratorLike = {
      runId: 'ai4',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async (text: string) => { received = text; return { ok: true } },
    }
    const { app, registry } = await build()
    registry.set('ai4', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai4/agent-input',
      payload: { data: 'hi\n' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'sent' })
    expect(received).toBe('hi\n')
  })
})

describe('POST /api/runs/:runId/restart', () => {
  it('restarts a terminal run in remaining-test mode', async () => {
    let received = ''
    const { app } = await build({
      restartRun: async (runId) => {
        received = runId
        return { ok: true, mode: 'remaining' }
      },
    })

    const res = await app.inject({ method: 'POST', url: '/api/runs/old-failed/restart' })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted', mode: 'remaining' })
    expect(received).toBe('old-failed')
  })

  it.each([
    ['run-not-found', 404],
    ['not-restartable', 409],
    ['already-active', 409],
    ['spawn-failed', 500],
  ] as const)('maps restart failure %s to HTTP %d', async (reason, statusCode) => {
    const { app } = await build({
      restartRun: async () => ({ ok: false, reason }),
    })

    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/restart' })

    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/abort', () => {
  it('stops a registered orchestrator and 204s', async () => {
    const stub = makeStub('r2')
    const { app, registry } = await build()
    registry.set('r2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r2/abort' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    expect(registry.get('r2')).toBeUndefined()
  })

  it('preserves the run dir/history when an active orchestrator is aborted', async () => {
    writeManifestForRun('r2b') // baseline manifest exists
    const stub = makeStub('r2b')
    const { app, registry } = await build()
    registry.set('r2b', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r2b/abort' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    // History is preserved so the user can still audit logs.
    expect(fs.existsSync(runDirFor(logsDir, 'r2b'))).toBe(true)
  })

  it('404s when run is not active', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/abort' })
    expect(res.statusCode).toBe(404)
  })

  it('aborts an orphaned persisted active run instead of 404ing', async () => {
    const dir = runDirFor(logsDir, 'orphan')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'orphan',
      feature: 'foo',
      startedAt: 'now',
      status: 'running',
      healCycles: 0,
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    })
    writeRunsIndex(logsDir, [
      { runId: 'orphan', feature: 'foo', startedAt: 'now', status: 'running' },
    ])
    const { app } = await build()

    const res = await app.inject({ method: 'POST', url: '/api/runs/orphan/abort' })

    expect(res.statusCode).toBe(204)
    expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('aborted')
    expect(readManifest(path.join(dir, 'manifest.json'))?.services[0].status).toBe('stopped')
    expect(readRunsIndex(logsDir)[0].status).toBe('aborted')
  })

  it('still 204s if stop() throws (best-effort)', async () => {
    const failing: OrchestratorLike = {
      runId: 'r4',
      stop: async () => { throw new Error('nope') },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('r4', failing)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r4/abort' })
    expect(res.statusCode).toBe(204)
    expect(registry.get('r4')).toBeUndefined()
  })
})

describe('DELETE /api/runs/:runId', () => {
  it('removes a terminal run from history (index entry + run dir) and 204s', async () => {
    writeManifestForRun('r3') // status: 'passed'
    writeRunsIndex(logsDir, [
      { runId: 'r3', feature: 'foo', startedAt: 'now', status: 'passed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3' })
    expect(res.statusCode).toBe(204)
    expect(fs.existsSync(runDirFor(logsDir, 'r3'))).toBe(false)
    const list = await app.inject({ method: 'GET', url: '/api/runs' })
    expect((list.json() as Array<{ runId: string }>).find((r) => r.runId === 'r3')).toBeUndefined()
  })

  it('409s and preserves the run when an orchestrator is still registered', async () => {
    writeManifestForRun('r3b')
    const stub = makeStub('r3b')
    const { app, registry } = await build()
    registry.set('r3b', stub)
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3b' })
    expect(res.statusCode).toBe(409)
    expect(stub.stopped).toBe(false)
    expect(fs.existsSync(runDirFor(logsDir, 'r3b'))).toBe(true)
  })

  it('409s when the manifest still claims running but no orch is registered', async () => {
    const dir = runDirFor(logsDir, 'r3c')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r3c', feature: 'foo', startedAt: 'now', status: 'running', healCycles: 0, services: [],
    })
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3c' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run is still active; reap or abort first' })
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('404s when run unknown entirely', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/ghost' })
    expect(res.statusCode).toBe(404)
  })
})
