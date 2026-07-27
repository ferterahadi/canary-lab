import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

// Transparent pass-through by default — every other test in this file spawns
// real processes (fake npx/claude binaries on PATH). Only the one test below
// that needs to control child-process event ordering deterministically
// installs an override via setMockSpawn.
const { getMockSpawn, setMockSpawn } = vi.hoisted(() => {
  let impl: ((...args: unknown[]) => unknown) | null = null
  return {
    getMockSpawn: () => impl,
    setMockSpawn: (fn: ((...args: unknown[]) => unknown) | null) => { impl = fn },
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const impl = getMockSpawn()
      return impl ? impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { scoutStage } from './scout'

import { attemptLogLine, describeAttempt, docsStage } from './docs'

import { prdSummaryStage } from './prd-summary'

import { buildSpecsPrompt, specsCoverageStage, defaultValidateSpecs, tscErrorsForFeature } from './specs-coverage'

import { runStage, healStage } from './run'

import { evaluationExportStage } from './evaluation-export'

import type { FlightInject, FlightStageDeps } from './context'

import { defaultSpawnAgent, extractJson, pollUntil, PollTimeoutError } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'

import { writeEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'

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

function ctxFor(m: FlightManifest): { ctx: StageContext; current: () => FlightManifest; setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void; progressLog: unknown[] } {
  const state = { m }
  const progressLog: unknown[] = []
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  return {
    progressLog,
    ctx: {
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      signal: new AbortController().signal,
      appendLog: () => {},
      setProgress: (progress) => { progressLog.push(progress) },
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

const VALID_CONFIG = (name = 'checkout') => configCjs(name, '/tmp/x', 'checkout flow')

describe('replay-safe checkpoint answers (R78 seamless resume)', () => {
  it("run 'rerun' re-attaches to a still-active rerun instead of double-starting into its own repo lock", async () => {
    let reads = 0
    const calls: InjectCall[] = []
    const inject = makeInject((c) => {
      if (c.method === 'GET' && c.url === '/api/runs/r2') {
        reads += 1
        // First read (the replay guard) sees it live; the verdict poll then
        // finds it terminal so the test settles fast.
        return { statusCode: 200, body: { manifest: { status: reads === 1 ? 'running' : 'passed', healCycles: 0 } } }
      }
      return undefined
    }, calls)
    const { ctx } = ctxFor(manifest({ links: { runId: 'r2' } }))

    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'rerun' })

    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'r2', status: 'passed' } })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs')).toBe(false)
  })

  it("run 'rerun' still force-starts a new run when the linked run is terminal", async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((c) => {
      if (c.method === 'GET' && c.url === '/api/runs/r-old') {
        return { statusCode: 200, body: { manifest: { status: 'failed', healCycles: 1 } } }
      }
      if (c.method === 'POST' && c.url === '/api/runs') {
        return { statusCode: 201, body: { runId: 'r-new' } }
      }
      if (c.method === 'GET' && c.url === '/api/runs/r-new') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0 } } }
      }
      return undefined
    }, calls)
    const { ctx } = ctxFor(manifest({ links: { runId: 'r-old' } }))

    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'rerun' })

    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'r-new', status: 'passed' } })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs')).toBe(true)
  })

  it("run 'rerun' force-starts without any lookup when the flight has no linked run", async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((c) => {
      if (c.method === 'POST' && c.url === '/api/runs') return { statusCode: 201, body: { runId: 'r-new' } }
      if (c.method === 'GET' && c.url === '/api/runs/r-new') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0 } } }
      }
      return undefined
    }, calls)

    const outcome = await runStage(deps({ inject })).onCheckpointResponse!(ctxFor(manifest()).ctx, { choice: 'rerun' })

    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'r-new', status: 'passed' } })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/runs' })
  })

  it('evaluation-export re-attaches to its still-running task on a replayed answer instead of starting a duplicate', async () => {
    const m = manifest({ links: { runId: 'r1', evaluationTaskId: 'eval-live' } })
    const { ctx } = ctxFor(m)
    // A live task on disk, already download-ready so the poll settles at once.
    writeEvaluationExportTask(logsDir, {
      taskId: 'eval-live',
      runId: 'r1',
      feature: 'checkout',
      mode: 'raw',
      status: 'completed',
      downloadReady: true,
      archiveBase: 'export-r1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as never)
    const exportDir = path.join(logsDir, 'evaluation-exports', 'eval-live')
    fs.mkdirSync(exportDir, { recursive: true })
    fs.writeFileSync(path.join(exportDir, 'export.zip'), 'zip')
    const calls: InjectCall[] = []

    const outcome = await evaluationExportStage(deps({ inject: makeInject(() => undefined, calls) })).onCheckpointResponse!(
      ctx,
      { choice: 'raw' },
    )

    expect(outcome).toMatchObject({ kind: 'done', evidence: { taskId: 'eval-live' } })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('starts a fresh export rather than re-attaching to a prior task that failed', async () => {
    // Re-attaching to a dead task would strand the stage forever, so a failed
    // (or errored) prior link has to be abandoned in favour of a new export.
    for (const prior of [
      { status: 'failed' as const, error: 'archive step crashed' },
      { status: 'completed' as const, error: 'archive step crashed' },
    ]) {
      const { ctx } = ctxFor(manifest({ links: { runId: 'r1', evaluationTaskId: 'eval-dead' } }))
      writeEvaluationExportTask(logsDir, {
        taskId: 'eval-dead', runId: 'r1', feature: 'checkout', mode: 'raw',
        downloadReady: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        ...prior,
      } as never)

      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
          writeEvaluationExportTask(logsDir, {
            taskId: 'eval-fresh', runId: 'r1', feature: 'checkout', mode: 'raw', status: 'completed',
            downloadReady: true, archiveBase: 'export-r1',
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          } as never)
          const dir = path.join(logsDir, 'evaluation-exports', 'eval-fresh')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, 'export.zip'), 'zip')
          return { statusCode: 202, body: { taskId: 'eval-fresh' } }
        }
        return undefined
      }, calls)

      const outcome = await evaluationExportStage(deps({ inject })).onCheckpointResponse!(ctx, { choice: 'raw' })

      expect(outcome).toMatchObject({ kind: 'done', evidence: { taskId: 'eval-fresh' } })
      expect(calls.some((c) => c.method === 'POST')).toBe(true)
    }
  })
})

describe('flight agent selection (R79)', () => {
  const CODEX_SUMMARY = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00Z',
    requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'], variants: [] }],
  })
  const LEDGER = (pct: number) => ({
    feature: 'checkout',
    requirements: [],
    tests: [],
    totals: { total: 1, covered: pct >= 100 ? 1 : 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
    coveragePct: pct,
    mappedPct: pct,
    orphanRequirementIds: [],
    orphanTestNames: [],
  })

  const ORIGINAL_CODEX_BIN = process.env.CANARY_LAB_CODEX_BIN
  afterEach(() => {
    if (ORIGINAL_CODEX_BIN === undefined) delete process.env.CANARY_LAB_CODEX_BIN
    else process.env.CANARY_LAB_CODEX_BIN = ORIGINAL_CODEX_BIN
  })

  it('defaultSpawnAgent spawns codex (exec, prompt on stdin) and records a codex session ref', async () => {
    const script = path.join(tmpDir, 'fake-codex.sh')
    fs.writeFileSync(script, '#!/bin/sh\ncat > /dev/null\necho "codex answer"\n')
    fs.chmodSync(script, 0o755)
    process.env.CANARY_LAB_CODEX_BIN = script
    const stageDir = path.join(tmpDir, 'stage-codex')
    fs.mkdirSync(stageDir, { recursive: true })

    const result = await defaultSpawnAgent({ prompt: 'do it', cwd: tmpDir, stageDir, agent: 'codex' })

    expect(result.text.trim()).toBe('codex answer')
    const ref = JSON.parse(fs.readFileSync(path.join(stageDir, 'agent-session.json'), 'utf-8'))
    expect(ref.activeAgent).toBe('codex')
  })

  it('scout passes the flight agent to the spawner', async () => {
    const agents: Array<string | undefined> = []
    const d = deps({
      spawnAgent: async (o) => {
        agents.push(o.agent)
        return { text: JSON.stringify({ configSource: VALID_CONFIG(), envFiles: [] }) }
      },
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } })
    await scoutStage(d).run(ctxFor(m).ctx)
    expect(agents).toEqual(['codex'])
  })

  it('docs collector passes the flight agent to the spawner', async () => {
    const agents: Array<string | undefined> = []
    const d = deps({ spawnAgent: async (o) => { agents.push(o.agent); return { text: 'NOTHING_FOUND: nope' } } })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } })
    const { ctx, setStage } = ctxFor(m)
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    setStage('docs', { status: 'waiting-for-approval', checkpoint: { kind: 'prd-source', message: 'q', options: ['collect-repo-docs'] } })
    await docsStage(d).onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    expect(agents).toEqual(['codex'])
  })

  it('prd-summary forwards the flight agent as the engine adapter', async () => {
    const adapters: Array<string | undefined> = []
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const d = deps({
      coverage: { regenerate: (async (args: { adapter?: string }) => { adapters.push(args.adapter); return {} }) as never },
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } })
    await prdSummaryStage(d).run(ctxFor(m).ctx)
    expect(adapters).toEqual(['codex'])
  })

  it('specs loop forwards the flight agent to both the author spawner and the mapping engine', async () => {
    const agents: Array<string | undefined> = []
    const adapters: Array<string | undefined> = []
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), CODEX_SUMMARY)
    const ledgers = [LEDGER(0), LEDGER(100)]
    const AUTHORED_SPEC = `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'\n\ntest('checkout @req-R1 @path-happy', async ({ page }) => { expect(1).toBe(1) })\n`
    const d = deps({
      spawnAgent: async (o) => {
        agents.push(o.agent)
        const e2eDir = path.join(featuresDir, 'checkout', 'e2e')
        fs.mkdirSync(e2eDir, { recursive: true })
        fs.writeFileSync(path.join(e2eDir, 'checkout.spec.ts'), AUTHORED_SPEC)
        return { text: 'wrote e2e/checkout.spec.ts' }
      },
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => (ledgers.shift() ?? LEDGER(100))) as never,
        runEngine: (async (args: { adapter?: string }) => { adapters.push(args.adapter); return {} }) as never,
      },
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, agent: 'codex' } })
    const outcome = await specsCoverageStage(d).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(agents).toEqual(['codex'])
    expect(adapters).toEqual(['codex'])
  })
})
