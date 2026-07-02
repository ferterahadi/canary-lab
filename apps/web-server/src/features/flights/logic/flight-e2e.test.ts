import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FlightRunStore } from './store'
import { startFlight, respondToFlightCheckpoint, type FlightConductorDeps } from './conductor'
import { buildFlightStageAdapters } from './stages'
import type { FlightStageDeps } from './stages/context'
import { writeEvaluationExportTask } from '../../evaluation/logic/evaluation-export-store'
import type { FlightOptions } from './types'

// Integration proof over the real fixture repo (tools/fixtures/first-flight-app):
// the REAL conductor + REAL stage adapters (similarity scan, scout validation,
// scaffold, env capture, docs gathering, spec apply, portify skip-mark, verdict
// wiring, export link) — with the process boundaries stubbed at their existing
// seams: the agent CLI (spawnAgent), the runs/portify/evaluation routes
// (inject), and the coverage engines (deps.coverage). The live end-to-end run
// (real boots, real agents, real heal) is the scripted protocol in the todo
// hub's artifacts/ — this test pins everything deterministic around it.

const FIXTURE = path.resolve(__dirname, '../../../../../../tools/fixtures/first-flight-app')

let tmpDir: string
let featuresDir: string
let logsDir: string
let repoDir: string
let store: FlightRunStore

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-e2e-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'first-flight-app')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.cpSync(FIXTURE, repoDir, { recursive: true })
  store = new FlightRunStore(logsDir)
})
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function scoutAnswer(feature: string, repo: string): string {
  const config = [
    'const config = {',
    `  name: '${feature}',`,
    "  description: 'todo flow',",
    "  envs: ['local'],",
    '  repos: [{',
    "    name: 'first-flight-app',",
    `    localPath: '${repo}',`,
    "    startCommands: [{ name: 'api', command: 'npm run dev', ports: [{ name: 'api', env: 'PORT' }], healthCheck: { http: { url: 'http://localhost:${port.api}/health' } } }],",
    '  }],',
    '  featureDir: __dirname,',
    '}',
    'module.exports = { config }',
  ].join('\n')
  return '```json\n' + JSON.stringify({ configSource: config, envFiles: [path.join(repo, '.env')] }) + '\n```'
}

const SPEC = [
  "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'",
  '',
  "test('created todo appears in the list @req-R1 @path-happy', async ({ request }) => {",
  '  expect(1).toBe(1)',
  '})',
  '',
].join('\n')

function specsAnswer(): string {
  return '```json\n' + JSON.stringify({ files: [{ path: 'e2e/todos.spec.ts', content: SPEC }] }) + '\n```'
}

function buildDeps(feature: string): { deps: FlightConductorDeps; spawnAgent: ReturnType<typeof vi.fn> } {
  const spawnAgent = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('onboarding product repo')) return { text: scoutAnswer(feature, repoDir) }
    if (prompt.includes('authoring Playwright E2E specs')) return { text: specsAnswer() }
    throw new Error(`unexpected agent prompt: ${prompt.slice(0, 80)}`)
  })

  let coveragePcts = [0, 100]
  const featureDirOf = (name: string): string => path.join(featuresDir, name)

  const stageDeps: FlightStageDeps = {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    spawnAgent,
    coverage: {
      regenerate: (async (args: { featuresDir: string; feature: string }) => {
        const docsDir = path.join(args.featuresDir, args.feature, 'docs')
        expect(fs.readdirSync(docsDir).some((f) => !f.startsWith('_'))).toBe(true)
        fs.writeFileSync(
          path.join(docsDir, '_prd-summary.json'),
          JSON.stringify({
            requirements: [{ id: 'R1', title: 'create→list', text: 'a created todo appears in the list', pathTypes: ['happy'] }],
            docsHash: 'h', sourceDocs: ['first-flight-app-readme.md'], generatedAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        )
        return {} as never
      }) as never,
      compute: ((args: { feature: string }) => {
        const pct = coveragePcts.length > 1 ? coveragePcts.shift()! : coveragePcts[0]
        return {
          feature: args.feature,
          requirements: [], tests: [],
          totals: { total: 1, covered: pct === 100 ? 1 : 0, pathIncomplete: 0, variantIncomplete: 0, untested: pct === 100 ? 0 : 1, orphanTests: 0 },
          coveragePct: pct, mappedPct: pct, orphanRequirementIds: [], orphanTestNames: [],
        }
      }) as never,
      runEngine: (async () => ({}) as never) as never,
    },
    inject: async ({ method, url, payload }) => {
      // Boot + test runs settle instantly at their happy verdicts.
      if (method === 'POST' && url === '/api/runs') {
        const mode = (payload as { mode?: string } | undefined)?.mode
        return { statusCode: 201, json: () => ({ runId: mode === 'boot' ? 'boot-1' : 'run-1' }) }
      }
      if (method === 'GET' && url.startsWith('/api/runs/boot-1')) {
        return { statusCode: 200, json: () => ({ manifest: { status: 'running', services: [{ name: 'api', status: 'ready' }] } }) }
      }
      if (method === 'GET' && url.startsWith('/api/runs/run-1')) {
        return { statusCode: 200, json: () => ({ manifest: { status: 'passed', healCycles: 1, services: [] } }) }
      }
      if (method === 'POST' && url.endsWith('/abort')) return { statusCode: 204, json: () => ({}) }
      // Portify: native port injection — ready with zero edits, save writes the mark.
      if (method === 'POST' && url === '/api/portify') return { statusCode: 201, json: () => ({ workflowId: 'wf-1' }) }
      if (method === 'GET' && url.startsWith('/api/portify/wf-1') ) {
        const marked = fs.existsSync(path.join(featureDirOf(flightFeature()), 'portify', 'meta.json'))
        return { statusCode: 200, json: () => ({ status: marked ? 'saved' : 'ready-to-save', diff: '' }) }
      }
      if (method === 'POST' && url.endsWith('/save')) {
        const dir = path.join(featureDirOf(flightFeature()), 'portify')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, featureName: flightFeature(), agent: 'claude', repos: [{ name: 'first-flight-app' }], capturedAt: 'x' }))
        return { statusCode: 200, json: () => ({}) }
      }
      // Evaluation export: task settles ready with the zip on disk.
      if (method === 'POST' && url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-fl-1', runId: 'run-1', feature: flightFeature(), mode: 'raw', status: 'completed',
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', downloadReady: true,
          archiveBase: 'canary-lab-evaluation',
        } as never)
        fs.writeFileSync(path.join(logsDir, 'evaluation-exports', 'eval-fl-1', 'export.zip'), 'PK')
        return { statusCode: 202, json: () => ({ taskId: 'eval-fl-1' }) }
      }
      return { statusCode: 500, json: () => ({ error: `unstubbed ${method} ${url}` }) }
    },
  }

  // The scaffold stage may re-point the flight's feature (name collision), so
  // the portify/export stubs read the CURRENT name off the store.
  const flightFeature = (): string => store.list()[0]?.feature ?? feature

  const deps: FlightConductorDeps = { store, adapters: buildFlightStageAdapters(stageDeps) }
  return { deps, spawnAgent }
}

const OPTS_YOLO: FlightOptions = { env: 'local', coverageTarget: 100, yolo: true }

describe('first flight end-to-end (real adapters over the fixture repo)', () => {
  it('takes the bare fixture repo to done with zero hand-edited files, ending in the evaluation archive', async () => {
    const { deps, spawnAgent } = buildDeps('first-flight-app')
    const { manifest, completion } = startFlight(
      { feature: 'first-flight-app', repoPaths: [repoDir], description: 'todo flow', opts: OPTS_YOLO },
      deps,
    )
    await completion

    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.runVerdict).toBe('passed')

    // Feature scaffolded from the scout's draft — nothing hand-written.
    const featureDir = path.join(featuresDir, final.feature)
    const config = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
    expect(config).toContain("command: 'npm run dev'")
    expect(config).toContain('${port.api}')
    // Env captured from the repo's .env.
    expect(final.stages.find((s) => s.key === 'env-capture')!.status).toBe('done')
    // Docs gathered from the repo README (yolo auto-descends the hierarchy).
    expect(fs.readdirSync(path.join(featureDir, 'docs')).some((f) => !f.startsWith('_'))).toBe(true)
    // Specs authored + applied through the draft validation.
    expect(fs.readFileSync(path.join(featureDir, 'e2e', 'todos.spec.ts'), 'utf-8')).toContain('@req-R1')
    // Coverage loop settled at the target and recorded the ledger as evidence.
    expect(final.stages.find((s) => s.key === 'specs-coverage')!.evidence).toMatchObject({ coveragePct: 100 })
    // Portify earned the mark.
    expect(fs.existsSync(path.join(featureDir, 'portify', 'meta.json'))).toBe(true)
    // The deliverable: an evaluation archive on disk, linked from the manifest.
    expect(final.links?.evaluationZip).toBeTruthy()
    expect(fs.existsSync(final.links!.evaluationZip!)).toBe(true)
    // Heal mirrored the run's single heal cycle.
    expect(final.stages.find((s) => s.key === 'heal')!.evidence).toMatchObject({ healCycles: 1 })

    expect(spawnAgent).toHaveBeenCalledTimes(2) // scout + one specs round
  })

  it('a second fly on the same repo hits the similarity checkpoint; rerun reaches the export without re-authoring', async () => {
    const first = buildDeps('first-flight-app')
    await startFlight(
      { feature: 'first-flight-app', repoPaths: [repoDir], description: 'todo flow', opts: OPTS_YOLO },
      first.deps,
    ).completion
    expect(store.get(store.list()[0].flightId)!.status).toBe('done')

    // Second flight, non-yolo: must PARK on the three-way choice, never
    // silently scaffold a near-duplicate.
    const second = buildDeps('first-flight-app')
    const { manifest, completion } = startFlight(
      { feature: 'first-flight-app-again', repoPaths: [repoDir], description: 'todo flow again', opts: { ...OPTS_YOLO, yolo: false } },
      second.deps,
    )
    await completion
    const parked = store.get(manifest.flightId)!
    expect(parked.status).toBe('waiting-for-approval')
    expect(parked.stages.find((s) => s.key === 'similarity')!.checkpoint?.kind).toBe('similarity-choice')

    const resumed = respondToFlightCheckpoint(manifest.flightId, { choice: 'rerun' }, second.deps)
    await resumed.completion
    const final = store.get(manifest.flightId)!
    expect(final.status).toBe('done')
    expect(final.feature).toBe('first-flight-app') // re-pointed at the existing feature
    expect(final.links?.evaluationZip).toBeTruthy()
    // Authoring stages were skipped — no agent ran on the rerun path.
    expect(second.spawnAgent).not.toHaveBeenCalled()
    for (const key of ['scout', 'scaffold', 'env-capture', 'docs', 'prd-summary', 'specs-coverage', 'portify'] as const) {
      expect(final.stages.find((s) => s.key === key)!.status).toBe('skipped')
    }
  })
})
