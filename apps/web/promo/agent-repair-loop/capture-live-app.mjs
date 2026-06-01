import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const outDir = path.join(here, 'public/live-app')
const width = 1920
const height = 1080
const fps = 24
const durationSeconds = 20
const frameCount = fps * durationSeconds
const healingStartFrame = 128
const rerunStartFrame = 226
const journalStartFrame = 300
const finalStartFrame = 374
const journalScrollEndFrame = finalStartFrame - 3
const port = Number(process.env.CANARY_PROMO_PORT ?? 5184)
const baseUrl = `http://127.0.0.1:${port}`
const runId = '2026-06-01T0412-checkout'
const startedAt = '2026-06-01T04:12:00.000Z'

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const tests = [
  'main page loads',
  'auth redirects anonymous shoppers',
  'cart starts empty',
  'cart persists across refresh',
  'product search filters inventory',
  'checkout creates order',
  'coupon applies discount',
  'payment captures total',
  'receipt can be opened',
  'email receipt is queued',
  'inventory decrements after purchase',
  'refund preview uses order total',
  'tax estimate uses shipping state',
  'saved address pre-fills checkout',
  'guest checkout creates profile',
  'shipping quote updates cart',
  'order history shows latest order',
  'webhook signs payment event',
  'admin dashboard lists order',
  'analytics event records checkout',
  'retry keeps cart id stable',
  'mobile checkout keeps CTA visible',
].map((name, index) => ({
  id: `checkout-${String(index + 1).padStart(2, '0')}`,
  name,
  line: 12 + index * 7,
}))

const features = [
  'checkout',
  'billing',
  'onboarding',
  'inventory',
  'auth',
  'reporting',
  'notifications',
].map((name) => ({
  name,
  description: `${name} workflow`,
  envs: ['local', 'staging'],
  repos: [{ name: `${name}-app`, localPath: `/workspace/${name}` }],
}))

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function summaryName(test) {
  return `test-case-${slugify(test.name)}`
}

function knownTests() {
  return tests.map((test) => ({
    id: test.id,
    name: summaryName(test),
    title: test.name,
    titlePath: ['checkout', test.name],
    location: `e2e/checkout.spec.ts:${test.line}:3`,
  }))
}

function featureTests() {
  return [{
    file: 'e2e/checkout.spec.ts',
    tests: tests.map((test) => ({
      id: test.id,
      name: test.name,
      line: test.line,
      sourceFile: 'e2e/checkout.spec.ts',
      bodySource: [
        `await page.goto('/checkout')`,
        `await expect(page.getByRole('heading')).toContainText('Checkout')`,
        `await checkout.complete('${test.id}')`,
        `await expect(order.total()).toBe(expectedTotal)`,
      ].join('\n'),
      steps: [
        { label: 'open checkout', line: test.line + 1, bodySource: "await page.goto('/checkout')", children: [] },
        { label: 'complete checkout flow', line: test.line + 3, bodySource: `await checkout.complete('${test.id}')`, children: [] },
        { label: 'verify total', line: test.line + 4, bodySource: 'await expect(order.total()).toBe(expectedTotal)', children: [] },
      ],
    })),
  }]
}

function runningStep(test, category = 'expect') {
  return {
    id: test.id,
    name: summaryName(test),
    location: `e2e/checkout.spec.ts:${test.line + 4}:7`,
    step: {
      title: 'expect order total',
      category,
      location: `e2e/checkout.spec.ts:${test.line + 4}:7`,
      locations: [`e2e/checkout.spec.ts:${test.line + 4}:7`],
    },
  }
}

function summary(stage) {
  const allIds = tests.map((test) => test.id)
  const allNames = tests.map(summaryName)
  const base = {
    total: tests.length,
    skipped: 0,
    skippedNames: [],
    skippedIds: [],
    knownTests: knownTests(),
  }

  if (stage === 'running') {
    const passed = tests.slice(0, 5)
    const runningTests = [tests[5], tests[6], tests[7], tests[15]].map((test) => runningStep(test))
    return {
      ...base,
      complete: false,
      passed: passed.length,
      passedIds: passed.map((test) => test.id),
      passedNames: passed.map(summaryName),
      running: runningTests[0],
      runningTests,
      failed: [],
    }
  }

  if (stage === 'failed' || stage === 'healing') {
    const passed = tests.slice(0, 5)
    const failedTest = tests[5]
    return {
      ...base,
      complete: true,
      passed: passed.length,
      passedIds: passed.map((test) => test.id),
      passedNames: passed.map(summaryName),
      failed: [{
        id: failedTest.id,
        name: summaryName(failedTest),
        durationMs: 9100,
        location: `e2e/checkout.spec.ts:${failedTest.line + 4}:7`,
        locations: [`e2e/checkout.spec.ts:${failedTest.line + 4}:7`],
        error: {
          message: 'Expected $124.00 but received $112.00',
          snippet: 'expect(order.total()).toBe("$124.00")',
        },
        traceSummaryFile: 'playwright-report/checkout-total.trace.zip',
      }],
    }
  }

  if (stage === 'rerun') {
    const passed = tests.slice(0, 18)
    const runningTests = [tests[5], tests[18], tests[21]].map((test) => runningStep(test, 'retry'))
    return {
      ...base,
      complete: false,
      passed: passed.length,
      passedIds: passed.map((test) => test.id),
      passedNames: passed.map(summaryName),
      running: runningTests[0],
      runningTests,
      failed: [],
    }
  }

  return {
    ...base,
    complete: true,
    passed: tests.length,
    passedIds: allIds,
    passedNames: allNames,
    failed: [],
  }
}

function playbackEvents(stage) {
  const failedTest = tests[5]
  if (stage === 'passed') {
    return tests.slice(0, 9).map((test, index) => ({
      type: 'test-end',
      time: `04:16:${String(10 + index).padStart(2, '0')}`,
      test: { name: summaryName(test), title: test.name, location: `e2e/checkout.spec.ts:${test.line}:3` },
      status: 'passed',
      passed: true,
      durationMs: 1200 + index * 140,
      retry: index === 5 ? 1 : 0,
    }))
  }
  return [{
    type: 'test-end',
    time: '04:13:44',
    test: { name: summaryName(failedTest), title: failedTest.name, location: `e2e/checkout.spec.ts:${failedTest.line}:3` },
    status: 'failed',
    passed: false,
    durationMs: 9100,
    retry: 0,
    error: { message: 'Expected $124.00 but received $112.00', snippet: 'expect(order.total()).toBe("$124.00")' },
    attachments: [{ name: 'trace', contentType: 'application/zip', path: 'playwright-report/trace.zip' }],
  }]
}

function artifactGroups(stage) {
  if (stage === 'running') return []
  return [{
    testName: summaryName(tests[5]),
    testTitle: tests[5].name,
    artifacts: [
      {
        name: 'trace.zip',
        kind: 'trace',
        path: '/tmp/trace.zip',
        url: '/artifacts/trace.zip',
        contentType: 'application/zip',
        sizeBytes: 182_000,
        mtimeMs: 1_779_000_000_000,
      },
      {
        name: 'checkout.png',
        kind: 'screenshot',
        path: '/tmp/checkout.png',
        url: '/artifacts/checkout.png',
        contentType: 'image/png',
        sizeBytes: 91_000,
        mtimeMs: 1_779_000_000_000,
      },
    ],
  }]
}

function services(stage) {
  const active = stage === 'passed' ? 'passed' : 'running'
  return [
    {
      name: 'checkout-web',
      safeName: 'checkout-web',
      repoName: 'checkout-app',
      command: 'npm run dev',
      cwd: '/workspace/checkout-app',
      logPath: '/tmp/checkout-web.log',
      healthUrl: 'http://127.0.0.1:4210',
      status: active,
    },
    {
      name: 'payment-api',
      safeName: 'payment-api',
      repoName: 'payments',
      command: 'npm run dev:api',
      cwd: '/workspace/payments',
      logPath: '/tmp/payment-api.log',
      healthUrl: 'http://127.0.0.1:4211',
      status: active,
    },
    {
      name: 'mailer',
      safeName: 'mailer',
      repoName: 'notifications',
      command: 'npm run dev:worker',
      cwd: '/workspace/notifications',
      logPath: '/tmp/mailer.log',
      status: active,
    },
  ]
}

function detail(stage) {
  const runStatus = stage === 'failed'
    ? 'failed'
    : stage === 'healing'
    ? 'healing'
    : stage === 'passed'
    ? 'passed'
    : 'running'
  const endedAt = runStatus === 'failed' ? '2026-06-01T04:13:44.000Z' : runStatus === 'passed' ? '2026-06-01T04:17:22.000Z' : undefined
  return {
    runId,
    manifest: {
      runId,
      feature: 'checkout',
      env: 'local',
      startedAt,
      endedAt,
      status: runStatus,
      healCycles: stage === 'passed' ? 9 : stage === 'healing' || stage === 'rerun' ? 6 : 0,
      services: services(stage),
      healMode: 'external',
      externalHealSession: stage === 'healing' || stage === 'rerun' ? {
        sessionId: 'promo-agent-session',
        clientKind: 'other',
        conversationName: 'AI Agent',
        claimedAt: '2026-06-01T04:14:01.000Z',
        lastHeartbeatAt: new Date().toISOString(),
        status: stage === 'rerun' ? 'running-tests' : 'healing',
        cycleCount: stage === 'rerun' ? 7 : 6,
      } : undefined,
      playwrightArtifacts: { screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'retain-on-failure' },
      repoBranches: [
        { name: 'checkout-app', path: '/workspace/checkout-app', branch: 'main', expectedBranch: 'main', detached: false, dirty: stage !== 'running' },
        { name: 'payments', path: '/workspace/payments', branch: 'main', expectedBranch: 'main', detached: false, dirty: false },
      ],
      lifecycle: {
        events: [
          { phase: 'starting-services', headline: 'Starting services', updatedAt: startedAt },
          { phase: 'running-tests', headline: 'Running Playwright tests', updatedAt: '2026-06-01T04:12:18.000Z' },
          ...(runStatus === 'failed' || stage === 'healing' || stage === 'rerun' || stage === 'passed'
            ? [{ phase: 'failed', headline: 'Run failed', updatedAt: '2026-06-01T04:13:44.000Z' }]
            : []),
          ...(stage === 'healing' || stage === 'rerun' || stage === 'passed'
            ? [{ phase: 'healing', headline: 'AI Agent is healing the failure', updatedAt: '2026-06-01T04:14:01.000Z' }]
            : []),
          ...(stage === 'rerun' || stage === 'passed'
            ? [{ phase: 'running-tests', headline: 'Rerunning failed tests', updatedAt: '2026-06-01T04:16:04.000Z' }]
            : []),
          ...(stage === 'passed'
            ? [{ phase: 'passed', headline: 'All tests passed', updatedAt: '2026-06-01T04:17:22.000Z' }]
            : []),
        ],
      },
    },
    summary: summary(stage),
    playbackEvents: playbackEvents(stage),
    playwrightArtifacts: artifactGroups(stage),
  }
}

function runs(stage) {
  const current = detail(stage).manifest
  return [
    { runId, feature: 'checkout', startedAt, status: current.status, endedAt: current.endedAt },
    { runId: '2026-06-01T0331-checkout', feature: 'checkout', startedAt: '2026-06-01T03:31:00.000Z', status: 'aborted', endedAt: '2026-06-01T03:35:50.000Z' },
    { runId: '2026-06-01T0306-checkout', feature: 'checkout', startedAt: '2026-06-01T03:06:00.000Z', status: 'failed', endedAt: '2026-06-01T03:08:59.000Z' },
  ]
}

function journalEntries() {
  const entries = [
    { badge: 'regression', label: 'fail', signal: 'heal', fix: 'Inspect saved Playwright evidence.' },
    { badge: 'pending', label: 'heal', signal: 'agent patching', fix: 'Patch checkout total calculation.' },
    { badge: 'regression', label: 'fail', signal: 'heal', fix: 'Read app logs and retry with tax state.' },
    { badge: 'pending', label: 'heal', signal: 'agent patching', fix: 'Wait for discount state before submit.' },
    { badge: 'regression', label: 'fail', signal: 'heal', fix: 'Inspect retained trace and screenshot.' },
    { badge: 'pending', label: 'heal', signal: 'agent patching', fix: 'Patch final order summary.' },
    { badge: 'partial', label: 'rerun', signal: 'rerun tests', fix: 'Run the targeted checkout tests again.' },
    { badge: 'all_passed', label: 'pass', signal: 'full feature rerun', fix: 'Verify every checkout test.' },
    { badge: 'all_passed', label: 'complete', signal: 'done', fix: 'Keep the repair and journal.' },
  ]

  return entries.map((entry, index) => ({
    iteration: index + 1,
    timestamp: new Date(Date.UTC(2026, 5, 1, 4, 13 + index, 12)).toISOString(),
    feature: 'checkout',
    run: runId,
    outcome: entry.badge,
    hypothesis: entry.badge === 'all_passed'
      ? 'The checkout total now matches the order summary.'
      : 'The checkout total is calculated before tax and discount state settle.',
    body: [
      `- outcome: ${entry.label}`,
      `- hypothesis: ${entry.badge === 'all_passed' ? 'Fix verified by rerun.' : 'Checkout total drift found in order calculation.'}`,
      `- fix.description: ${entry.fix}`,
      `- signal: ${entry.signal}`,
    ].join('\n'),
  }))
}

function stateForFrame(frame) {
  if (frame < 116) return 'running'
  if (frame < healingStartFrame) return 'failed'
  if (frame < rerunStartFrame) return 'healing'
  if (frame < journalStartFrame) return 'rerun'
  return 'passed'
}

function tabForFrame(frame) {
  if (frame >= journalStartFrame && frame < finalStartFrame) return 'Journal'
  if (frame >= 116 && frame < healingStartFrame) return 'Playwright'
  if (frame >= healingStartFrame && frame < journalStartFrame) return 'Heal agent'
  return 'Overview'
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl)
      if (res.ok) return
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Vite server did not start at ${baseUrl}`)
}

function startServer() {
  const viteBin = path.join(root, 'node_modules/vite/bin/vite.js')
  const child = spawn(process.execPath, [
    viteBin,
    '--config',
    'apps/web/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`))
  return child
}

function responseJson(body) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

const server = startServer()
let browser
let currentStage = 'running'

try {
  await waitForServer()
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  })
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  })

  await page.addInitScript(() => {
    window.localStorage.setItem('canary-lab.theme', 'dark')
    const sockets = []
    class FakeWebSocket {
      constructor(url) {
        this.url = String(url)
        this.readyState = 0
        this.binaryType = 'blob'
        sockets.push(this)
        setTimeout(() => {
          this.readyState = 1
          this.onopen?.({ type: 'open' })
          if (this.url.includes('/ws/workspace')) {
            this.onmessage?.({ data: JSON.stringify({ type: 'connected' }) })
          }
        }, 0)
      }
      send() {}
      close() {
        this.readyState = 3
        this.onclose?.({ type: 'close' })
      }
      addEventListener(type, handler) {
        this[`on${type}`] = handler
      }
      removeEventListener(type) {
        this[`on${type}`] = null
      }
      dispatchEvent() {
        return true
      }
      __emit(payload) {
        this.onmessage?.({ data: JSON.stringify(payload) })
      }
    }
    FakeWebSocket.CONNECTING = 0
    FakeWebSocket.OPEN = 1
    FakeWebSocket.CLOSING = 2
    FakeWebSocket.CLOSED = 3
    window.WebSocket = FakeWebSocket
    window.__canaryPromoSendWs = (path, payload) => {
      for (const socket of sockets) {
        if (socket.url.includes(path) && socket.readyState === 1) socket.__emit(payload)
      }
    }
  })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/mcp/health') {
      return route.fulfill(responseJson({
        ok: true,
        server: { name: 'canary-lab', version: 'promo' },
        profile: url.searchParams.get('profile') ?? 'repair',
        clientKind: 'ai-agent',
        toolCount: 8,
        tools: ['start_run', 'claim_heal', 'get_heal_context', 'signal_run'],
        activeSessions: 1,
        projectRoot: root,
      }))
    }
    if (url.pathname === '/api/features') return route.fulfill(responseJson(features))
    if (url.pathname === '/api/features/checkout/tests') return route.fulfill(responseJson(featureTests()))
    if (url.pathname === '/api/evaluation-exports') return route.fulfill(responseJson([]))
    if (url.pathname === '/api/tests/draft') return route.fulfill(responseJson([]))
    if (url.pathname === '/api/runs') return route.fulfill(responseJson(runs(currentStage)))
    if (url.pathname === `/api/runs/${encodeURIComponent(runId)}`) return route.fulfill(responseJson(detail(currentStage)))
    if (url.pathname === `/api/runs/${encodeURIComponent(runId)}/audit`) return route.fulfill(responseJson({ entries: [] }))
    if (url.pathname === '/api/journal') return route.fulfill(responseJson(journalEntries()))
    return route.continue()
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.evaluate((snapshot) => {
    window.__canaryPromoSendWs('/ws/runs', snapshot)
  }, { type: 'snapshot', runs: runs(currentStage), details: { [runId]: detail(currentStage) } })
  await page.waitForSelector('text=checkout')

  let activeTab = ''
  let activeStage = ''
  for (let frame = 0; frame < frameCount; frame += 1) {
    currentStage = stateForFrame(frame)
    if (currentStage !== activeStage) {
      activeStage = currentStage
      await page.evaluate((input) => {
        window.__canaryPromoSendWs('/ws/runs', input)
      }, { type: 'update', runId, detail: detail(currentStage) })
      await page.waitForTimeout(60)
    }

    const nextTab = tabForFrame(frame)
    if (nextTab !== activeTab) {
      activeTab = nextTab
      await page.evaluate((label) => {
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent?.trim() === label)
        button?.click()
      }, nextTab)
      await page.waitForTimeout(80)
    }

    if (nextTab === 'Journal') {
      const progress = Math.max(0, Math.min(1, (frame - journalStartFrame) / (journalScrollEndFrame - journalStartFrame)))
      const easedProgress = Math.pow(progress, 0.76)
      await page.evaluate((amount) => {
        const iterationNode = [...document.querySelectorAll('li')]
          .find((node) => node.textContent?.includes('Iteration'))
        const scroller = iterationNode?.closest('.overflow-y-auto')
        if (scroller) {
          scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * (1 - amount)
        }
      }, easedProgress)
    }

    await page.screenshot({
      path: path.join(outDir, `frame-${String(frame).padStart(4, '0')}.jpg`),
      type: 'jpeg',
      quality: 92,
    })

    if (frame % 48 === 0) {
      console.log(`captured ${frame}/${frameCount}`)
    }
  }
  console.log(`captured ${frameCount} frames in ${outDir}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
