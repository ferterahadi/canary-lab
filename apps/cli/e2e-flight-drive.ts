/**
 * Scripted end-to-end drive of the Flight experience (R53–R68 verification).
 *
 * Boots the REAL flight routes + conductor + stage adapters over a temp
 * workspace and the first-flight fixture repo, with the process boundaries
 * seam-injected to settle instantly (agent CLI, runs/portify/export routes,
 * coverage engines) — then drives the full journey the way the UI would and
 * asserts every new semantic:
 *
 *   1. start (non-yolo) → parks waiting-for-approval (attention state) with
 *      `flights-changed` observed on the workspace bus
 *   2. checkpoint responses walk it to done
 *   3. Start Over (mode redo, NO repos/description) → the SAME flightId,
 *      stages reset and re-driven to done
 *   4. redo with DIFFERENT repos / intent → 409 `flight_frozen`
 *   5. DELETE /api/flights/:id → record gone from the (collapsed) list
 *   6. plan-features on a broad intent → 3 proposed features
 *   7. launch → 3 flights: first drives, siblings park `queued`, the drain
 *      runs them strictly one at a time to done
 *   8. the shared `group` lands in every scaffolded feature.config.cjs
 *
 * Run with: npm run e2e:flight
 */
import Fastify from 'fastify'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { flightsRoutes } from '../web-server/src/features/flights/routes/flights'
import { FlightRunStore } from '../web-server/src/features/flights/logic/store'
import { buildFlightStageAdapters } from '../web-server/src/features/flights/logic/stages/index'
import type { FlightStageDeps } from '../web-server/src/features/flights/logic/stages/context'
import { WorkspaceEventBus } from '../web-server/src/shared/workspace-events'
import { writeEvaluationExportTask } from '../web-server/src/features/evaluation/logic/evaluation-export-store'
import type { FlightManifest, PlanFeaturesTask } from '../../shared/flights/types'

const FIXTURE = path.resolve(__dirname, '../../tools/fixtures/first-flight-app')
const DEADLINE_MS = 60_000

let passed = 0
function ok(label: string): void {
  passed += 1
  console.log(`  ✅ ${label}`)
}
function fail(label: string, detail?: unknown): never {
  console.error(`  ❌ ${label}`)
  if (detail !== undefined) console.error('     ', detail)
  process.exit(1)
}
function assert(cond: unknown, label: string, detail?: unknown): void {
  if (!cond) fail(label, detail)
  ok(label)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-drive-')))
  const featuresDir = path.join(tmpDir, 'features')
  const logsDir = path.join(tmpDir, 'logs')
  const repoDir = path.join(tmpDir, 'first-flight-app')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.cpSync(FIXTURE, repoDir, { recursive: true })
  const otherRepo = fs.mkdtempSync(path.join(tmpDir, 'other-repo-'))

  const store = new FlightRunStore(logsDir)
  const bus = new WorkspaceEventBus()
  let flightsChanged = 0
  // Sequential-drain proof: at no observed moment may two flights be actively
  // working the repo (running or parked on a checkpoint), and the launched
  // siblings must pass through the paused/queued parking state.
  let maxConcurrentActive = 0
  let sawQueued = false
  bus.subscribe((event) => {
    if (event.type !== 'flights-changed') return
    flightsChanged += 1
    const all = store.list()
    const active = all.filter((f) => f.status === 'running' || f.status === 'waiting-for-approval')
    maxConcurrentActive = Math.max(maxConcurrentActive, active.length)
    if (all.some((f) => f.status === 'paused' && f.pauseReason === 'queued')) sawQueued = true
  })

  // ── Seams: instant agents + instant run/portify/export back-ends ─────────
  const scoutAnswer = (feature: string): string => {
    const config = [
      'const config = {',
      `  name: '${feature}',`,
      "  description: 'todo flow',",
      "  envs: ['local'],",
      '  repos: [{',
      "    name: 'first-flight-app',",
      `    localPath: '${repoDir}',`,
      "    startCommands: [{ name: 'api', command: 'npm run dev', ports: [{ name: 'api', env: 'PORT' }], healthCheck: { http: { url: 'http://localhost:${port.api}/health' } } }],",
      '  }],',
      '  featureDir: __dirname,',
      '}',
      'module.exports = { config }',
    ].join('\n')
    return '```json\n' + JSON.stringify({ configSource: config, envFiles: [path.join(repoDir, '.env')] }) + '\n```'
  }
  const SPEC = [
    "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'",
    '',
    "test('created todo appears in the list @req-R1 @path-happy', async ({ request }) => {",
    '  expect(1).toBe(1)',
    '})',
    '',
  ].join('\n')

  // The seams resolve "which feature is being worked on" straight off the
  // store (the drain starts queued flights on its own schedule — a script-side
  // variable would race it).
  const currentFeatureName = (): string => {
    const active = store.list().find((f) => f.status === 'running' || f.status === 'waiting-for-approval')
    return active?.feature ?? store.list()[0]?.feature ?? 'first-flight-app'
  }
  const spawnAgent = async ({ prompt }: { prompt: string }): Promise<{ text: string }> => {
    if (prompt.includes('onboarding product repo')) return { text: scoutAnswer(currentFeatureName()) }
    if (prompt.includes('authoring Playwright E2E specs')) {
      const e2eDir = path.join(featuresDir, currentFeatureName(), 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      fs.writeFileSync(path.join(e2eDir, 'todos.spec.ts'), SPEC)
      return { text: '```json\n' + JSON.stringify({ files: [{ path: 'e2e/todos.spec.ts', content: SPEC }] }) + '\n```' }
    }
    throw new Error(`unexpected agent prompt: ${prompt.slice(0, 80)}`)
  }

  // The breakdown agent: a broad intent splits into three grouped features.
  const planAgent = async (): Promise<{ text: string }> => ({
    text: '```json\n' + JSON.stringify({
      split: true,
      features: [
        { name: 'todos-crud', description: 'create, list, complete todos', scope: 'the /todos API', group: 'first-flight-app' },
        { name: 'todos-filters', description: 'filter + search todos', scope: 'query params', group: 'first-flight-app' },
        { name: 'todos-health', description: 'service health + boot', scope: '/health', group: 'first-flight-app' },
      ],
    }) + '\n```',
  })

  const stageDeps: FlightStageDeps = {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    spawnAgent,
    coverage: {
      regenerate: (async (args: { featuresDir: string; feature: string }) => {
        fs.writeFileSync(
          path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'),
          JSON.stringify({
            requirements: [{ id: 'R1', title: 'create→list', text: 'a created todo appears in the list', pathTypes: ['happy'] }],
            docsHash: 'h', sourceDocs: ['first-flight-app-readme.md'], generatedAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        return {} as never
      }) as never,
      compute: ((args: { feature: string }) => ({
        feature: args.feature,
        requirements: [], tests: [],
        totals: { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
        coveragePct: 100, mappedPct: 100, orphanRequirementIds: [], orphanTestNames: [],
      })) as never,
      runEngine: (async () => ({}) as never) as never,
    },
    inject: async ({ method, url, payload }) => {
      if (method === 'POST' && url === '/api/runs') {
        const mode = (payload as { mode?: string } | undefined)?.mode
        return { statusCode: 201, json: () => ({ runId: mode === 'boot' ? `boot-${currentFeatureName()}` : `run-${currentFeatureName()}` }) }
      }
      if (method === 'GET' && url.startsWith('/api/runs/boot-')) {
        return { statusCode: 200, json: () => ({ manifest: { status: 'running', services: [{ name: 'api', status: 'ready' }] } }) }
      }
      if (method === 'GET' && url.startsWith('/api/runs/run-')) {
        return { statusCode: 200, json: () => ({ manifest: { status: 'passed', healCycles: 0, services: [] } }) }
      }
      if (method === 'POST' && url.endsWith('/abort')) return { statusCode: 204, json: () => ({}) }
      if (method === 'POST' && url === '/api/portify') return { statusCode: 201, json: () => ({ workflowId: `wf-${currentFeatureName()}` }) }
      if (method === 'GET' && url.startsWith('/api/portify/wf-')) {
        const marked = fs.existsSync(path.join(featuresDir, currentFeatureName(), 'portify', 'meta.json'))
        return { statusCode: 200, json: () => ({ status: marked ? 'saved' : 'ready-to-save', diff: '' }) }
      }
      if (method === 'POST' && url.endsWith('/save')) {
        const dir = path.join(featuresDir, currentFeatureName(), 'portify')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, featureName: currentFeatureName(), agent: 'claude', repos: [{ name: 'first-flight-app' }], capturedAt: 'x' }))
        return { statusCode: 200, json: () => ({}) }
      }
      if (method === 'POST' && url.endsWith('/evaluation-export')) {
        const taskId = `eval-${currentFeatureName()}`
        writeEvaluationExportTask(logsDir, {
          taskId, runId: `run-${currentFeatureName()}`, feature: currentFeatureName(), mode: 'raw', status: 'completed',
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', downloadReady: true,
          archiveBase: 'canary-lab-evaluation',
        } as never)
        fs.writeFileSync(path.join(logsDir, 'evaluation-exports', taskId, 'export.zip'), 'PK')
        return { statusCode: 202, json: () => ({ taskId }) }
      }
      return { statusCode: 500, json: () => ({ error: `unstubbed ${method} ${url}` }) }
    },
  }

  const app = Fastify({ logger: false })
  await app.register(flightsRoutes, {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    adapters: buildFlightStageAdapters(stageDeps),
    flightStore: store,
    planAgent,
    workspaceEvents: bus,
  })

  const get = async <T>(url: string): Promise<{ status: number; body: T }> => {
    const res = await app.inject({ method: 'GET', url })
    return { status: res.statusCode, body: res.json() as T }
  }
  const post = async <T>(url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
    const res = await app.inject({ method: 'POST', url, payload: payload ?? {} })
    return { status: res.statusCode, body: res.json() as T }
  }

  /** Poll a flight to a settled/parked state, answering checkpoints the way
   *  the happy-path user would. */
  const CHOICE_BY_KIND: Record<string, string> = {
    'config-approval': 'approve',
    'prd-source': 'use-repo-docs',
    'export-mode': 'raw',
    'similarity-choice': 'rerun',
  }
  const driveToDone = async (flightId: string): Promise<FlightManifest> => {
    const deadline = Date.now() + DEADLINE_MS
    for (;;) {
      if (Date.now() > deadline) fail(`flight ${flightId} did not settle within ${DEADLINE_MS}ms`, store.get(flightId)?.status)
      const flight = (await get<FlightManifest>(`/api/flights/${flightId}`)).body
      if (flight.status === 'done') return flight
      if (flight.status === 'failed' || flight.status === 'aborted') {
        fail(`flight ${flightId} settled ${flight.status}`, flight.error ?? flight.stages.find((s) => s.error)?.error)
      }
      if (flight.status === 'waiting-for-approval') {
        const parked = flight.stages.find((s) => s.status === 'waiting-for-approval')
        const kind = parked?.checkpoint?.kind ?? ''
        const choice = CHOICE_BY_KIND[kind] ?? parked?.checkpoint?.options?.[0]
        const res = await post(`/api/flights/${flightId}/respond`, { response: { choice } })
        if (res.status !== 200) fail(`checkpoint respond (${kind}) rejected`, res.body)
      }
      await sleep(25)
    }
  }

  // ── 1+2: start non-yolo → attention park → responses → done ──────────────
  console.log('▸ start → park → respond → done')
  const started = await post<FlightManifest>('/api/flights', {
    feature: 'first-flight-app', repoPaths: [repoDir], description: 'todo flow', env: 'local', coverageTarget: 100,
  })
  assert(started.status === 201, 'POST /api/flights → 201', started.body)
  const flightId = started.body.flightId
  const parkDeadline = Date.now() + DEADLINE_MS
  let parked: FlightManifest
  for (;;) {
    parked = (await get<FlightManifest>(`/api/flights/${flightId}`)).body
    if (parked.status === 'waiting-for-approval') break
    if (Date.now() > parkDeadline) fail('flight never parked for approval', parked.status)
    await sleep(25)
  }
  assert(parked.stages.some((s) => s.checkpoint), 'parked waiting-for-approval with a checkpoint (attention state)')
  assert(flightsChanged > 0, `flights-changed observed on the workspace bus (${flightsChanged} so far)`)
  const done = await driveToDone(flightId)
  assert(done.runVerdict === 'passed', 'checkpoint choices walked the flight to done (run passed)')

  // ── 3: Start Over reuses the record ───────────────────────────────────────
  console.log('▸ Start Over (redo) reuses the record')
  const redo = await post<FlightManifest>('/api/flights', { feature: 'first-flight-app', mode: 'redo' })
  assert(redo.status === 201, 'redo with NO repos/description accepted (stored args reused)', redo.body)
  assert(redo.body.flightId === flightId, `redo reuses the SAME flightId (${flightId})`)
  assert(redo.body.stages.every((s) => s.status === 'pending' || s.status === 'running'), 'redo reset the stage records')
  await driveToDone(flightId)
  assert(store.list().filter((f) => f.feature === 'first-flight-app').length === 1, 'still exactly one record for the feature')

  // ── 4: frozen repos + intent ──────────────────────────────────────────────
  console.log('▸ frozen repos + intent')
  const wrongRepo = await post<{ type?: string }>('/api/flights', {
    feature: 'first-flight-app', mode: 'redo', repoPaths: [otherRepo],
  })
  assert(wrongRepo.status === 409 && wrongRepo.body.type === 'flight_frozen', 'differing repos → 409 flight_frozen', wrongRepo.body)
  const wrongIntent = await post<{ type?: string }>('/api/flights', {
    feature: 'first-flight-app', mode: 'redo', description: 'something completely different',
  })
  assert(wrongIntent.status === 409 && wrongIntent.body.type === 'flight_frozen', 'differing intent → 409 flight_frozen', wrongIntent.body)

  // ── 5: delete ─────────────────────────────────────────────────────────────
  console.log('▸ delete the flight')
  const del = await app.inject({ method: 'DELETE', url: `/api/flights/${flightId}` })
  assert(del.statusCode === 200 && (del.json() as { deleted: boolean }).deleted, 'DELETE → { deleted: true }')
  const list = (await get<{ flights: FlightManifest[] }>('/api/flights')).body.flights
  assert(!list.some((f) => f.flightId === flightId), 'record gone from GET /api/flights')

  // ── 6: plan-features breakdown ────────────────────────────────────────────
  console.log('▸ plan-features breakdown')
  const plan = await post<PlanFeaturesTask>('/api/flights/plan-features', {
    repoPaths: [repoDir], description: 'test everything in this repo',
  })
  assert(plan.status === 202, 'POST plan-features → 202', plan.body)
  let task: PlanFeaturesTask = plan.body
  const planDeadline = Date.now() + DEADLINE_MS
  while (task.status === 'running') {
    if (Date.now() > planDeadline) fail('plan task never settled')
    await sleep(25)
    task = (await get<PlanFeaturesTask>(`/api/flights/plan-features/${task.taskId}`)).body
  }
  assert(task.status === 'done' && task.result?.features.length === 3, 'plan settled with 3 proposed features', task)

  // ── 7: launch → sequential queue drain ────────────────────────────────────
  console.log('▸ launch → sequential drain')
  maxConcurrentActive = 0
  const launch = await post<{ flightIds: string[] }>(`/api/flights/plan-features/${task.taskId}/launch`, {
    features: task.result!.features, yolo: true,
  })
  assert(launch.status === 201 && launch.body.flightIds.length === 3, 'launch → 3 flights', launch.body)
  const [first] = launch.body.flightIds
  assert(sawQueued, 'siblings observed parked paused/queued on the bus')

  // The drain starts each queued flight automatically as the previous one
  // settles — the yolo path needs no checkpoint answers, so just wait.
  const flightDeadline = Date.now() + DEADLINE_MS * 3
  for (;;) {
    if (Date.now() > flightDeadline) {
      fail('launched batch never finished', store.list().map((f) => `${f.feature}:${f.status}(${f.pauseReason ?? ''})`))
    }
    const all = launch.body.flightIds.map((id) => store.get(id)!)
    if (all.every((f) => f.status === 'done')) break
    const settled = all.find((f) => f.status === 'failed' || f.status === 'aborted')
    if (settled) fail(`flight ${settled.feature} settled ${settled.status}`, settled.error)
    await sleep(25)
  }
  ok('all 3 flights reached done')
  assert(maxConcurrentActive <= 1, `strictly sequential: max concurrent active flights = ${maxConcurrentActive}`)
  assert(store.get(first)!.status === 'done', 'first flight done')

  // ── 8: group landed in every scaffolded config ────────────────────────────
  console.log('▸ group in feature.config.cjs')
  for (const name of ['todos-crud', 'todos-filters', 'todos-health']) {
    const config = fs.readFileSync(path.join(featuresDir, name, 'feature.config.cjs'), 'utf-8')
    assert(config.includes("group: 'first-flight-app'"), `${name}: group present in feature.config.cjs`)
  }

  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\n✅ e2e flight drive passed — ${passed} assertions`)
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ e2e flight drive crashed:', err)
  process.exit(1)
})
