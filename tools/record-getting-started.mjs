import fs from 'fs'
import path from 'path'
import process from 'process'
import { fileURLToPath } from 'url'
import { chromium } from 'playwright'

// Export needs a passed storefront run. The all-workflows recording waits for
// Repair to pass before opening Export's Flight stage.
const WORKFLOW_ORDER = ['verify', 'portify', 'author', 'run', 'export', 'flight', 'coverage']
const KNOWN_WORKFLOWS = new Set(WORKFLOW_ORDER)
const DEFAULT_OUTPUT = path.resolve('output', 'playwright', 'getting-started')
const RUN_PASS_TIMEOUT_MS = 15 * 60 * 1000
const FLIGHT_STAGE_TIMEOUT_MS = 30 * 60 * 1000
const COMPLETION_STAGE = {
  portify: 'portify',
  export: 'evaluation-export',
}

function usage() {
  return `Record every executable Getting Started action against a running Canary Lab workspace.

Usage:
  node tools/record-getting-started.mjs --url http://127.0.0.1:7421 [options]

Options:
  --workflow <id|all>  Record one workflow or every catalog workflow (default: all)
  --output <dir>       Video and manifest directory (default: output/playwright/getting-started)
  --headed             Show Chromium while recording
  --linger <ms>        Time to hold each destination on screen (default: 2200)
  --no-cleanup         Leave started runs, Flights, and background tasks active
  --help               Show this help

Use a disposable workspace for --workflow all. The recorder waits for Repair to
pass so Export can enter its server-validated Flight stage.`
}

export function parseArgs(argv) {
  const options = {
    workflow: 'all',
    output: DEFAULT_OUTPUT,
    headed: false,
    cleanup: true,
    lingerMs: 2200,
    url: null,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') options.help = true
    else if (arg === '--headed') options.headed = true
    else if (arg === '--no-cleanup') options.cleanup = false
    else if (arg === '--url') options.url = argv[++index] ?? null
    else if (arg === '--workflow') options.workflow = argv[++index] ?? ''
    else if (arg === '--output') options.output = path.resolve(argv[++index] ?? '')
    else if (arg === '--linger') options.lingerMs = Number.parseInt(argv[++index] ?? '', 10)
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.help) return options
  if (!options.url) throw new Error('--url is required')
  options.url = new URL(options.url).origin
  if (options.workflow !== 'all' && !KNOWN_WORKFLOWS.has(options.workflow)) {
    throw new Error(`--workflow must be all or one of: ${WORKFLOW_ORDER.join(', ')}`)
  }
  if (!Number.isFinite(options.lingerMs) || options.lingerMs < 0) {
    throw new Error('--linger must be a non-negative integer')
  }
  return options
}

export function workflowsToRecord(catalog, requested) {
  const byId = new Map(catalog.map((workflow) => [workflow.id, workflow]))
  const ids = requested === 'all' ? WORKFLOW_ORDER.filter((id) => byId.has(id)) : [requested]
  return ids.map((id) => {
    const workflow = byId.get(id)
    if (!workflow) throw new Error(`Getting Started does not offer ${id} in this workspace`)
    if (!workflow.internalAction) {
      throw new Error(`${workflow.title} cannot run here: ${workflow.unavailableReason ?? 'no internal action'}`)
    }
    return workflow
  })
}

export function needsPassedRunForExport(workflows, runs) {
  const action = workflows.find((workflow) => workflow.id === 'export')?.internalAction
  if (!action || action.kind !== 'export') return false
  return !runs.some((run) =>
    run.feature === action.feature
    && run.executionType !== 'boot'
    && run.executionType !== 'benchmark'
    && run.status === 'passed')
}

export function demoCheckpointChoice(workflowId, checkpointKind) {
  return {
    portify: { 'portify-gate': 'run', 'portify-apply': 'apply' },
    export: { 'export-mode': 'raw' },
  }[workflowId]?.[checkpointKind] ?? null
}

export function isSuccessfulDemoStage(stage) {
  if (stage?.status === 'done') return true
  return stage?.status === 'skipped'
    && typeof stage.skipReason === 'string'
    && stage.skipReason.includes('already portified')
}

async function readJson(response) {
  const raw = await response.text()
  return raw ? JSON.parse(raw) : null
}

async function api(baseUrl, route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, init)
  const body = await readJson(response)
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`)
  return body
}

function capturePosts(page, baseUrl) {
  const entries = []
  const pending = new Set()
  page.on('response', (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || !response.url().startsWith(`${baseUrl}/api/`)) return
    const task = readJson(response).then((body) => {
      entries.push({
        url: response.url(),
        status: response.status(),
        requestBody: request.postDataJSON?.() ?? null,
        body,
      })
    }).catch(() => {})
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  return {
    entries,
    settle: async () => { await Promise.all([...pending]) },
  }
}

function lastPost(posts, pattern) {
  return posts.findLast((entry) => pattern.test(new URL(entry.url).pathname)) ?? null
}

async function waitForDestination(page, workflowId, posts) {
  if (workflowId === 'verify') {
    await page.getByTestId('demo-dialog').waitFor({ state: 'hidden', timeout: 90_000 })
    const deadline = Date.now() + 30_000
    let runId = null
    while (Date.now() < deadline && !runId) {
      await posts.settle()
      runId = lastPost(posts.entries, /^\/api\/features\/[^/]+\/verifications$/)?.body?.runId ?? null
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!runId) throw new Error('Verify closed Getting Started without returning a verification run id')
    await page.waitForURL((url) => url.searchParams.get('run') === runId, { timeout: 30_000 })
    await page.locator('[data-testid="run-status-indicator"]').first().waitFor({ state: 'visible' })
    return
  }
  const flightStage = {
    coverage: 'specs-coverage',
    author: 'specs-coverage',
    portify: 'portify',
    export: 'evaluation-export',
  }[workflowId]
  if (flightStage) {
    await page.getByTestId('flight-status').waitFor({ state: 'visible', timeout: 90_000 })
    await page.locator(`[data-testid="stage-rail-${flightStage}"][aria-current="true"]`)
      .waitFor({ state: 'visible', timeout: 90_000 })
    return
  }
  const target = workflowId === 'flight'
    ? '[data-testid="flight-status"]'
    : '[data-testid="run-status-indicator"]'
  await page.locator(target).first().waitFor({ state: 'visible', timeout: 90_000 })
}

async function waitForDemoStageCompletion(page, baseUrl, workflowId) {
  const stageKey = COMPLETION_STAGE[workflowId]
  if (!stageKey) return
  const flightId = new URL(page.url()).searchParams.get('flight')
  if (!flightId) throw new Error(`${workflowId} reached the Flight page without a flight id`)

  const answered = new Set()
  const deadline = Date.now() + FLIGHT_STAGE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const flight = await api(baseUrl, `/api/flights/${encodeURIComponent(flightId)}`)
    const stage = flight.stages?.find((entry) => entry.key === stageKey)
    if (!stage) throw new Error(`Flight ${flightId} has no ${stageKey} stage`)
    if (isSuccessfulDemoStage(stage)) {
      const expected = stage.status === 'done' ? 'Done' : 'Skipped'
      await page.getByTestId('stage-status-chip').getByText(expected, { exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 })
      if (workflowId === 'export') {
        await page.getByTestId('flight-primary-download').waitFor({ state: 'visible', timeout: 30_000 })
      }
      return
    }
    if (stage.status === 'failed') {
      throw new Error(`${stageKey} failed: ${stage.error ?? flight.error ?? 'unknown error'}`)
    }
    if (stage.status === 'waiting-for-approval' && stage.checkpoint?.kind) {
      const choice = demoCheckpointChoice(workflowId, stage.checkpoint.kind)
      if (!choice) throw new Error(`${stageKey} stopped at unexpected checkpoint ${stage.checkpoint.kind}`)
      const answerKey = `${stage.checkpoint.kind}:${choice}`
      if (!answered.has(answerKey)) {
        answered.add(answerKey)
        const button = page.getByTestId(`checkpoint-choice-${choice}`)
        await button.waitFor({ state: 'visible', timeout: 30_000 })
        await button.click()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${stageKey} did not complete within 30 minutes`)
}

async function waitForPassedRun(baseUrl, runId, label = 'Repair') {
  const deadline = Date.now() + RUN_PASS_TIMEOUT_MS
  while (Date.now() < deadline) {
    const detail = await api(baseUrl, `/api/runs/${encodeURIComponent(runId)}`)
    const status = detail.manifest?.status
    if (status === 'passed') return
    if (status === 'failed' || status === 'aborted') {
      throw new Error(`${label} ended ${status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${label} did not pass within 15 minutes`)
}

async function waitForDemoSessionToSettle(baseUrl) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const onboarding = await api(baseUrl, '/api/onboarding')
    if (!onboarding.session.active) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Getting Started session stayed active after cleanup')
}

async function cleanUpLaunch(baseUrl, workflowId, posts, options) {
  if (workflowId === 'run') {
    const started = lastPost(posts, /^\/api\/runs$/)?.body
    if (options.awaitPassedRun && started?.runId) {
      await waitForDemoSessionToSettle(baseUrl)
      return 'kept passed run for Export'
    }
    if (started?.runId) await api(baseUrl, `/api/runs/${encodeURIComponent(started.runId)}/abort`, { method: 'POST' })
    await waitForDemoSessionToSettle(baseUrl)
    return 'aborted run'
  }
  if (workflowId === 'flight' || workflowId === 'author' || workflowId === 'portify' || workflowId === 'coverage' || workflowId === 'export') {
    const started = lastPost(posts, /^\/api\/flights$/)?.body
    if (started?.flightId) {
      const flight = await api(baseUrl, `/api/flights/${encodeURIComponent(started.flightId)}`)
      if (flight.status === 'running' || flight.status === 'waiting-for-approval') {
        await api(baseUrl, `/api/flights/${encodeURIComponent(started.flightId)}/pause`, { method: 'POST' })
      }
    }
    if (workflowId === 'flight') await waitForDemoSessionToSettle(baseUrl)
    return 'paused Flight'
  }
  if (workflowId === 'verify') {
    const ids = posts
      .filter((entry) => /^\/api\/(runs|features\/[^/]+\/verifications)$/.test(new URL(entry.url).pathname))
      .map((entry) => entry.body?.runId)
      .filter(Boolean)
    await Promise.all(ids.map((id) => api(baseUrl, `/api/runs/${encodeURIComponent(id)}/abort`, { method: 'POST' }).catch(() => null)))
    return `aborted ${ids.length} verification run${ids.length === 1 ? '' : 's'}`
  }
  return 'no cleanup needed'
}

async function recordWorkflow(browser, baseUrl, outputDir, workflow, options) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
  })
  const page = await context.newPage()
  const video = page.video()
  const posts = capturePosts(page, baseUrl)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await page.goto(`${baseUrl}/?dialog=demo`, { waitUntil: 'domcontentloaded' })
    await page.getByTestId('demo-dialog').waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(500)
    await page.getByTestId(`getting-started-workflow-${workflow.id}`).click()
    const action = page.getByTestId(`getting-started-action-${workflow.id}`)
    await action.waitFor({ state: 'visible' })
    if (await action.isDisabled()) {
      const detail = await page.getByTestId('getting-started-detail').innerText()
      throw new Error(`${workflow.title} is disabled:\n${detail}`)
    }
    await page.waitForTimeout(700)
    await action.click()
    await waitForDestination(page, workflow.id, posts)
    await posts.settle()
    await waitForDemoStageCompletion(page, baseUrl, workflow.id)
    if (workflow.id === 'run' && options.awaitPassedRun) {
      const started = lastPost(posts.entries, /^\/api\/runs$/)?.body
      if (!started?.runId) throw new Error('Repair did not return a run id')
      await waitForPassedRun(baseUrl, started.runId)
      await page.locator('[data-testid="run-status-indicator"][data-status="passed"]').first()
        .waitFor({ state: 'visible', timeout: 30_000 })
    }
    if (workflow.id === 'verify') {
      const runId = lastPost(posts.entries, /^\/api\/features\/[^/]+\/verifications$/)?.body?.runId
      if (!runId) throw new Error('Verify did not return a run id')
      await waitForPassedRun(baseUrl, runId, 'Verification')
      await page.locator('[data-testid="run-status-indicator"][data-status="passed"]').first()
        .waitFor({ state: 'visible', timeout: 30_000 })
    }
    await page.waitForTimeout(options.lingerMs)
    const cleanup = options.cleanup
      ? await cleanUpLaunch(baseUrl, workflow.id, posts.entries, options)
      : 'disabled'
    return { id: workflow.id, title: workflow.title, url: page.url(), cleanup, pageErrors: errors }
  } finally {
    await context.close()
    await video.saveAs(path.join(outputDir, `${workflow.id}.webm`))
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return
  }

  fs.mkdirSync(options.output, { recursive: true })
  const onboarding = await api(options.url, '/api/onboarding')
  const workflows = workflowsToRecord(onboarding.workflows, options.workflow)
  const runs = options.workflow === 'all' ? await api(options.url, '/api/runs') : []
  options.awaitPassedRun = options.workflow === 'all' && needsPassedRunForExport(workflows, runs)
  const browser = await chromium.launch({ headless: !options.headed, slowMo: 180 })
  const results = []

  try {
    for (const workflow of workflows) {
      console.log(`Recording ${workflow.title}…`)
      const result = await recordWorkflow(browser, options.url, options.output, workflow, options)
      results.push(result)
      console.log(`  ${path.join(options.output, `${workflow.id}.webm`)}`)
    }
  } finally {
    await browser.close()
    fs.writeFileSync(path.join(options.output, 'manifest.json'), `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      baseUrl: options.url,
      cleanup: options.cleanup,
      results,
    }, null, 2)}\n`)
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
