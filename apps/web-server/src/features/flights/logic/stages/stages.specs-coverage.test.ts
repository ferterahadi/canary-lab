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

import { buildSpecsPrompt, specsCoverageStage, defaultValidateSpecs, tscErrorsForFeature } from './specs-coverage'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'

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

  // The agent edits <featureDir>/e2e/*.spec.ts in place — the mock spawn
  // writes to disk like the real agent's Write tool would.
  function writingSpawnAgent(prompts: string[], content = SPEC): FlightStageDeps['spawnAgent'] {
    return async (opts) => {
      prompts.push(opts.prompt)
      const e2eDir = path.join(featuresDir, 'checkout', 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      fs.writeFileSync(path.join(e2eDir, 'checkout.spec.ts'), content)
      return { text: 'rewrote e2e/checkout.spec.ts' }
    }
  }

  it('loops author→map until the harness-computed ledger meets the target', async () => {
    const ledgers = [ledger(0), ledger(100)]
    let engineRuns = 0
    const prompts: string[] = []
    const d = deps({
      spawnAgent: writingSpawnAgent(prompts),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => ledgers.shift() ?? ledger(100)) as never,
        runEngine: (async () => { engineRuns += 1; return {} as never }) as never,
      },
    })
    const outcome = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    expect(engineRuns).toBe(1)
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'e2e', 'checkout.spec.ts'), 'utf-8')).toBe(SPEC)
    // Edit-in-place contract: absolute feature dir in the prompt, no inlined specs.
    expect(prompts[0]).toContain(path.join(featuresDir, 'checkout'))
    expect(prompts[0]).not.toContain('{{')
  })

  it('R27: publishes the loop shape — authoring/validating/mapping per pass, with the pass history', async () => {
    const ledgers = [ledger(0), ledger(40), ledger(100)]
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => ledgers.shift() ?? ledger(100)) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const { ctx, progressLog } = ctxFor(manifest())
    const outcome = await specsCoverageStage(d).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done' })

    const phases = (progressLog as Array<{ pass: number; phase: string }>).map((p) => `${p.pass}:${p.phase}`)
    expect(phases).toEqual([
      '1:authoring', '1:validating', '1:mapping', '1:mapping', // pass 1 settles at 40%
      '2:authoring', '2:validating', '2:mapping', '2:mapping', // pass 2 reaches 100%
    ])
    const last = progressLog.at(-1) as { maxPasses: number; target: number; passes: Array<{ pass: number; coveragePct?: number }> }
    expect(last.maxPasses).toBe(5)
    expect(last.passes).toEqual([
      { pass: 1, coveragePct: 40, gapsOpen: 1 },
      { pass: 2, coveragePct: 100, gapsOpen: 0 },
    ])
  })

  it('R27: a pass burned by validation is recorded with its note, not a coverage number', async () => {
    let call = 0
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => (call++ === 0 ? { ok: false, errors: 'boom' } : { ok: true }),
      coverage: {
        compute: (() => ledger(call === 0 ? 0 : call === 1 ? 0 : 100)) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const { ctx, progressLog } = ctxFor(manifest())
    const outcome = await specsCoverageStage(d).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    const last = progressLog.at(-1) as { passes: Array<{ pass: number; note?: string; coveragePct?: number }> }
    expect(last.passes[0]).toEqual({ pass: 1, note: 'specs failed to compile/list' })
    expect(last.passes[1]).toMatchObject({ pass: 2, coveragePct: 100 })
  })

  it('parks on coverage-stuck at the iteration bound and accept-partial settles with the ledger recorded', async () => {
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
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

  it('rejects structurally invalid on-disk specs and feeds the apply error into the next prompt', async () => {
    const badSpec = "import { test, expect } from '@playwright/test'\n\ntest('x', async () => {})\n"
    let engineRuns = 0
    let validations = 0
    const prompts: string[] = []
    const d = deps({
      spawnAgent: writingSpawnAgent(prompts, badSpec),
      validateSpecs: async () => { validations += 1; return { ok: true } },
      coverage: {
        compute: (() => ledger(0)) as never,
        runEngine: (async () => { engineRuns += 1; return {} as never }) as never,
      },
    })
    const parked = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'coverage-stuck' } })
    expect(engineRuns).toBe(0)
    expect(validations).toBe(0)
    expect(prompts).toHaveLength(5)
    expect(prompts[0]).not.toContain('failed to compile/list')
    expect(prompts[1]).toContain('failed to compile/list')
    expect(prompts[1]).toContain('must import')
  })

  it('feeds dry-run validation errors into the next iteration and skips mapping for broken specs', async () => {
    const ledgers = [ledger(0), ledger(0), ledger(100)]
    let engineRuns = 0
    const prompts: string[] = []
    const validations: Array<{ featureDir: string; projectRoot: string }> = []
    const d = deps({
      spawnAgent: writingSpawnAgent(prompts),
      validateSpecs: async (args) => {
        validations.push(args)
        if (validations.length === 1) return { ok: false, errors: 'e2e/checkout.spec.ts(3,1): error TS2304: Cannot find name' }
        return { ok: true }
      },
      coverage: {
        compute: (() => ledgers.shift() ?? ledger(100)) as never,
        runEngine: (async () => { engineRuns += 1; return {} as never }) as never,
      },
    })
    const outcome = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    // Iteration 1 failed the dry-run: no mapping agent spent, errors fed forward.
    expect(engineRuns).toBe(1)
    expect(validations).toHaveLength(2)
    expect(validations[0]).toEqual({ featureDir: path.join(featuresDir, 'checkout'), projectRoot: tmpDir })
    expect(prompts[0]).not.toContain('failed to compile/list')
    expect(prompts[1]).toContain('failed to compile/list')
    expect(prompts[1]).toContain('error TS2304')
    // The clean second iteration cleared the carry-over: no third spawn needed.
    expect(prompts).toHaveLength(2)
  })

  it('wires up all real default deps (no overrides) and fails fast when there is no PRD summary', async () => {
    // No spawnAgent/validateSpecs/coverage overrides — exercises every `?? default`
    // fallback in specsCoverageStage's factory body for real. The loop fails
    // before ever touching an agent or the coverage engine (no PRD summary yet).
    fs.rmSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), { force: true })
    const outcome = await specsCoverageStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no PRD summary') })
  })

  it('pins the coverage-map agent-session ref via onAgentSession', async () => {
    fs.mkdirSync(path.join(logsDir, 'flights', 'fl-test', 'coverage-map'), { recursive: true })
    const ledgers = [ledger(0), ledger(100)]
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: (() => ledgers.shift() ?? ledger(100)) as never,
        runEngine: (async (args: { onAgentSession?: (s: { agent: 'claude' | 'codex'; sessionId: string }) => void }) => {
          args.onAgentSession?.({ agent: 'claude', sessionId: 'map-sess-1' })
          return {} as never
        }) as never,
      },
    })
    const { ctx, current } = ctxFor(manifest())
    const outcome = await specsCoverageStage(d).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    const refPath = path.join(logsDir, 'flights', current().flightId, 'coverage-map', 'agent-session.json')
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
    expect(ref.sessions.claude.sessionId).toBe('map-sess-1')
  })

  it('checkpoint response: retry re-enters the loop (not just accept-partial)', async () => {
    let met = false
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: ((() => (met ? ledger(100) : ledger(0))) as unknown) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const adapter = specsCoverageStage(d)
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    expect(parked).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'coverage-stuck' } })
    if (parked.kind !== 'checkpoint') throw new Error('unreachable')
    setStage('specs-coverage', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    met = true
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'retry' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
  })
})
