import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { similarityStage } from './similarity'
import { scoutStage } from './scout'
import { scaffoldStage } from './scaffold'
import { envCaptureStage } from './env-capture'
import { docsStage } from './docs'
import { prdSummaryStage } from './prd-summary'
import { specsCoverageStage } from './specs-coverage'
import { portifyStage } from './portify'
import { runStage, healStage } from './run'
import { evaluationExportStage } from './evaluation-export'
import type { FlightInject, FlightStageDeps } from './context'
import type { StageContext } from '../conductor'
import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'
import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { writeEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'

let tmpDir: string
let featuresDir: string
let logsDir: string
let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-stages-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

type InjectCall = { method: string; url: string; payload?: unknown }
type InjectImpl = (call: InjectCall) => { statusCode: number; body: unknown } | undefined

function makeInject(impl: InjectImpl, calls: InjectCall[] = []): FlightInject {
  return async (opts) => {
    calls.push(opts)
    const out = impl(opts) ?? { statusCode: 500, body: { error: `unstubbed ${opts.method} ${opts.url}` } }
    return { statusCode: out.statusCode, json: () => out.body }
  }
}

function deps(over: Partial<FlightStageDeps> = {}): FlightStageDeps {
  return {
    featuresDir,
    logsDir,
    projectRoot: tmpDir,
    inject: makeInject(() => undefined),
    ...over,
  }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'similarity',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void } {
  const state = { m }
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  return {
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      appendLog: () => {},
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    },
    current: () => state.m,
    setStage,
  }
}

function configCjs(name: string, repoLocalPath: string, description = 'existing feature'): string {
  return [
    'const config = {',
    `  name: '${name}',`,
    `  description: '${description}',`,
    "  envs: ['local'],",
    `  repos: [{ name: 'app', localPath: '${repoLocalPath}', startCommands: ['npm run dev'] }],`,
    '  featureDir: __dirname,',
    '}',
    'module.exports = { config }',
    '',
  ].join('\n')
}

function writeFeatureConfigCjs(feature: string, repoLocalPath: string): void {
  const dir = path.join(featuresDir, feature)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), configCjs(feature, repoLocalPath))
}

const VALID_CONFIG = (name = 'checkout') => configCjs(name, '/tmp/x', 'checkout flow')

describe('similarity stage', () => {
  it('is done when no feature targets the repos', async () => {
    const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { match: null } })
  })

  it('parks on the three-way choice when a feature already covers the repo', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'similarity-choice', options: ['rerun', 'enhance', 'new'] },
    })
  })

  it('yolo defaults to rerun: jumps to run on the existing feature (never a silent duplicate)', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const { ctx, current } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } }))
    const outcome = await similarityStage(deps()).run(ctx)
    expect(outcome).toMatchObject({ kind: 'jump', to: 'run' })
    expect(current().feature).toBe('existing-checkout')
  })

  it('enhance re-enters the existing feature at docs', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const adapter = similarityStage(deps())
    const { ctx, current, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('similarity', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'enhance' })
    expect(outcome).toMatchObject({ kind: 'jump', to: 'docs' })
    expect(current().feature).toBe('existing-checkout')
  })
})

describe('scout stage', () => {
  const draftJson = (config: string) =>
    '```json\n' + JSON.stringify({ configSource: config, envFiles: [path.join(repoDir, '.env')] }) + '\n```'

  it('drafts, validates the parse, and parks on config-approval', async () => {
    const d = deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) })
    const outcome = await scoutStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'config-approval' } })
  })

  it('yolo skips the approval checkpoint', async () => {
    const d = deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await scoutStage(d).run(ctxFor(m).ctx)
    expect(outcome.kind).toBe('done')
  })

  it('fails when the draft does not parse', async () => {
    const d = deps({ spawnAgent: async () => ({ text: draftJson('this is not javascript {{{') }) })
    const outcome = await scoutStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('does not parse') })
  })

  it('approve settles the stage with the draft as evidence', async () => {
    const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scout', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('module.exports') } })
  })
})

describe('scaffold stage', () => {
  function withScoutEvidence(m: FlightManifest, configSource: string): FlightManifest {
    return {
      ...m,
      stages: m.stages.map((s) => (s.key === 'scout' ? { ...s, status: 'done' as const, evidence: { configSource, envFiles: [] } } : s)),
    }
  }

  it('scaffolds the feature and lays the approved config over the skeleton', async () => {
    const { ctx } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('done')
    const written = fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')
    expect(written).toContain("name: 'checkout'")
    expect(written).toContain('startCommands')
  })

  it('never overwrites an existing feature — picks a free name and re-points the flight', async () => {
    writeFeatureConfigCjs('checkout', path.join(tmpDir, 'other-repo'))
    const { ctx, current } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('done')
    expect(current().feature).toBe('checkout-2')
    expect(fs.readFileSync(path.join(featuresDir, 'checkout-2', 'feature.config.cjs'), 'utf-8')).toContain("name: 'checkout-2'")
    // The pre-existing feature is untouched.
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')).toContain('existing feature')
  })

  it('is idempotent on resume', async () => {
    const m = withScoutEvidence(manifest(), VALID_CONFIG())
    await scaffoldStage(deps()).run(ctxFor(m).ctx)
    const again = await scaffoldStage(deps()).run(ctxFor(m).ctx)
    expect(again).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })
})

describe('env-capture stage', () => {
  const bootInject = (calls: InjectCall[] = []): FlightInject =>
    makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET' && call.url.startsWith('/api/runs/boot-1')) {
        return { statusCode: 200, body: { manifest: { status: 'running', services: [{ name: 'app', status: 'ready' }] } } }
      }
      if (call.method === 'POST' && call.url === '/api/runs/boot-1/abort') return { statusCode: 204, body: {} }
      return undefined
    }, calls)

  function withScout(m: FlightManifest, envFiles: string[]): FlightManifest {
    return {
      ...m,
      stages: m.stages.map((s) => (s.key === 'scout' ? { ...s, status: 'done' as const, evidence: { configSource: 'x', envFiles } } : s)),
    }
  }

  it('captures detected env files then proves the config with a dry-run boot (and tears it down)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const envFile = path.join(repoDir, '.env')
    fs.writeFileSync(envFile, 'API_KEY=secret\n')
    const calls: InjectCall[] = []
    const outcome = await envCaptureStage(deps({ inject: bootInject(calls) })).run(ctxFor(withScout(manifest(), [envFile])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 1, boot: { runId: 'boot-1' } } })
    expect(calls.some((c) => c.url === '/api/runs/boot-1/abort')).toBe(true)
  })

  it('parks on missing-env when a detected env file does not exist (yolo does NOT skip this)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const m = withScout(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } }), [missing])
    const outcome = await envCaptureStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'missing-env', data: { missing: [missing] } } })
  })

  it('materializes user-supplied values at the missing path, then captures and boots', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { values: { API_KEY: 'abc' } })
    expect(outcome.kind).toBe('done')
    expect(fs.readFileSync(missing, 'utf-8')).toBe('API_KEY=abc\n')
  })

  it('fails the stage when the boot verify fails', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: {
              status: 'failed',
              services: [{ name: 'app', status: 'timeout' }],
              bootFailure: { service: 'app', safeName: 'app', reason: 'health-timeout', detail: 'x', logPath: '/tmp/app.log' },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('failed to boot') })
  })
})

describe('docs stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
  })

  it('is done immediately when docs already exist (dropped / MCP path)', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const outcome = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'existing' } })
  })

  it('yolo auto-gathers repo docs (README) into the feature', async () => {
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Product\nIt should do the thing.')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.length).toBeGreaterThan(0)
  })

  it('falls back to the description alone when the repo offers nothing', async () => {
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only', docs: ['description.md'] } })
  })

  it('parks on prd-source otherwise, and a drop while parked wins the hierarchy', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect(parked.checkpoint.kind).toBe('prd-source')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'dropped.md'), '# Dropped PRD')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'use-repo-docs' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'dropped' } })
  })
})

describe('prd-summary stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD')
  })

  const summaryJson = (count: number, generatedAt: string) =>
    JSON.stringify({
      requirements: Array.from({ length: count }, (_, i) => ({ id: `R${i + 1}`, title: `t${i}`, text: 'x', pathTypes: ['happy'] })),
      docsHash: 'h',
      sourceDocs: ['prd.md'],
      generatedAt,
    })

  it('runs the existing engine and settles on the harness-read summary file', async () => {
    const d = deps({
      coverage: {
        regenerate: (async (args: { featuresDir: string; feature: string }) => {
          fs.writeFileSync(path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'), summaryJson(2, new Date(Date.now() + 60_000).toISOString()))
          return {} as never
        }) as never,
      },
    })
    const outcome = await prdSummaryStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { requirementCount: 2 } })
  })

  it('fails when the engine yields no requirements (never agent say-so)', async () => {
    const d = deps({
      coverage: {
        regenerate: (async (args: { featuresDir: string; feature: string }) => {
          fs.writeFileSync(path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'), summaryJson(0, new Date().toISOString()))
          return {} as never
        }) as never,
      },
    })
    const outcome = await prdSummaryStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no requirements') })
  })

  it('reuses a summary fresher than the docs', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), summaryJson(1, new Date(Date.now() + 60_000).toISOString()))
    const outcome = await prdSummaryStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })
})

describe('specs-coverage stage', () => {
  const SPEC = `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'\n\ntest('checkout @req-R1 @path-happy', async ({ page }) => { expect(1).toBe(1) })\n`

  function ledger(pct: number): CoverageLedger {
    return {
      feature: 'checkout',
      requirements: pct >= 100 ? [] : [{ requirement: { id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }, annotatedTestNames: [], pathCoverage: [], gapType: 'untested', coverageStatus: 'uncovered' }],
      tests: [],
      totals: { total: 1, covered: pct >= 100 ? 1 : 0, pathIncomplete: 0, variantIncomplete: 0, untested: pct >= 100 ? 0 : 1, orphanTests: 0 },
      coveragePct: pct,
      mappedPct: pct,
      orphanRequirementIds: [],
      orphanTestNames: [],
    }
  }

  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'] }], docsHash: 'h', sourceDocs: [], generatedAt: new Date().toISOString() }),
    )
  })

  it('loops author→map until the harness-computed ledger meets the target', async () => {
    const ledgers = [ledger(0), ledger(100)]
    let engineRuns = 0
    const d = deps({
      spawnAgent: async () => ({ text: '```json\n' + JSON.stringify({ files: [{ path: 'e2e/checkout.spec.ts', content: SPEC }] }) + '\n```' }),
      coverage: {
        compute: (() => ledgers.shift() ?? ledger(100)) as never,
        runEngine: (async () => { engineRuns += 1; return {} as never }) as never,
      },
    })
    const outcome = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    expect(engineRuns).toBe(1)
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'e2e', 'checkout.spec.ts'), 'utf-8')).toBe(SPEC)
  })

  it('parks on coverage-stuck at the iteration bound and accept-partial settles with the ledger recorded', async () => {
    const d = deps({
      spawnAgent: async () => ({ text: '```json\n' + JSON.stringify({ files: [{ path: 'e2e/checkout.spec.ts', content: SPEC }] }) + '\n```' }),
      coverage: {
        compute: (() => ledger(0)) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const adapter = specsCoverageStage(d)
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'coverage-stuck' } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('specs-coverage', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'accept-partial' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { acceptedPartial: true, coveragePct: 0 } })
  })
})

describe('portify stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
  })

  function markPortified(): void {
    const dir = path.join(featuresDir, 'checkout', 'portify')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, featureName: 'checkout', agent: 'claude', repos: [{ name: 'app' }], capturedAt: 'x' }))
  }

  it('skips only when the portified mark already exists', async () => {
    markPortified()
    const outcome = await portifyStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('already portified') })
  })

  it('zero-edit fast path: saves without a checkpoint and verifies the mark', async () => {
    let status = 'verifying'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') { status = 'ready-to-save'; return { statusCode: 201, body: { workflowId: 'wf1' } } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: false } })
  })

  it('proposed edits park on portify-apply; apply saves and verifies', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/server.js\n+++ b/server.js' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { edits: true } })
  })
})

describe('run + heal stages', () => {
  const runInject = (finalStatus: string, healCycles = 0): FlightInject =>
    makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: finalStatus, healCycles, services: [] } } }
      return undefined
    })

  it('waits for the terminal verdict and records it on the flight', async () => {
    const { ctx, current } = ctxFor(manifest())
    const outcome = await runStage(deps({ inject: runInject('passed', 2) })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-1', status: 'passed', healCycles: 2 } })
    expect(current().runVerdict).toBe('passed')
    expect(current().links?.runId).toBe('run-1')
  })

  it('a non-green run parks on run-failed; export-as-is settles with status preserved', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 3) }))
    const { ctx, setStage, current } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed', options: ['rerun', 'export-as-is'] } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    expect(current().runVerdict).toBe('failed')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'export-as-is' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { status: 'failed' } })
  })

  it('yolo exports a failed run as-is without parking', async () => {
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await runStage(deps({ inject: runInject('failed', 1) })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { status: 'failed' } })
  })

  it('heal mirrors the run: done with cycles, skipped without', async () => {
    const withRun = manifest({ links: { runId: 'run-1' } })
    const healed = await healStage(deps({ inject: runInject('passed', 2) })).run(ctxFor(withRun).ctx)
    expect(healed).toMatchObject({ kind: 'done', evidence: { healCycles: 2 } })
    const clean = await healStage(deps({ inject: runInject('passed', 0) })).run(ctxFor(withRun).ctx)
    expect(clean).toMatchObject({ kind: 'skipped', reason: 'run needed no heal' })
  })
})

describe('evaluation-export stage', () => {
  it('drives the export task and settles only when the archive exists on disk', async () => {
    const taskDir = path.join(logsDir, 'evaluation-exports', 'eval-task-1')
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-1',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'raw',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: true,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
        } as never)
        fs.writeFileSync(path.join(taskDir, 'export.zip'), 'PK')
        return { statusCode: 202, body: { taskId: 'eval-task-1' } }
      }
      return undefined
    })
    const { ctx, current } = ctxFor(manifest({ links: { runId: 'run-1' } }))
    const outcome = await evaluationExportStage(deps({ inject })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { taskId: 'eval-task-1' } })
    expect(current().links?.evaluationZip).toBe(path.join(taskDir, 'export.zip'))
  })

  it('fails without a run and reuses an existing archive on resume', async () => {
    const noRun = await evaluationExportStage(deps()).run(ctxFor(manifest()).ctx)
    expect(noRun).toMatchObject({ kind: 'failed', error: expect.stringContaining('no run') })

    const zip = path.join(tmpDir, 'export.zip')
    fs.writeFileSync(zip, 'PK')
    const m = manifest({ links: { runId: 'run-1', evaluationZip: zip } })
    const reused = await evaluationExportStage(deps()).run(ctxFor(m).ctx)
    expect(reused).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })
})
