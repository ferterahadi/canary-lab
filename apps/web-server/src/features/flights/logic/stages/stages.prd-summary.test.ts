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

import { prdSummaryStage } from './prd-summary'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { stageContextStub } from './__fixtures__/stage-context'

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
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: path.join(logsDir, 'flights', state.m.flightId),
      setProgress: (progress) => { progressLog.push(progress) },
      addAgentSession: (session) => {
        const stage = state.m.stages.find((candidate) => candidate.key === 'prd-summary')
        setStage('prd-summary', { agentSessions: [...(stage?.agentSessions ?? []), session] })
      },
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    }),
    current: () => state.m,
    setStage,
  }
}

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

  it('reuses a summary fresher than the docs with multiple doc files (mtime scan keeps the true newest)', async () => {
    // A second, OLDER doc must not overwrite "newest" once a newer one is seen.
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'older.md'), 'older content')
    fs.utimesSync(path.join(featuresDir, 'checkout', 'docs', 'older.md'), new Date(0), new Date(0))
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), summaryJson(1, new Date(Date.now() + 60_000).toISOString()))
    const outcome = await prdSummaryStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })

  it('uses the real regeneratePrdSummary default when deps.coverage is not injected (fails fast: unknown feature)', async () => {
    // No coverage.regenerate override — exercises the `?? regeneratePrdSummary`
    // fallback for real. "does-not-exist" isn't a scaffolded feature, so the
    // real engine throws FeatureNotFoundError before it would ever spawn an agent.
    const m = manifest({ feature: 'does-not-exist' })
    await expect(prdSummaryStage(deps()).run(ctxFor(m).ctx)).rejects.toThrow('feature not found: does-not-exist')
  })

  it('regenerates when the existing summary is stale relative to the docs', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), summaryJson(1, new Date(0).toISOString()))
    let regenerated = false
    const d = deps({
      coverage: {
        regenerate: (async (args: { featuresDir: string; feature: string }) => {
          regenerated = true
          fs.writeFileSync(path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'), summaryJson(3, new Date(Date.now() + 60_000).toISOString()))
          return {} as never
        }) as never,
      },
    })
    const outcome = await prdSummaryStage(d).run(ctxFor(manifest()).ctx)
    expect(regenerated).toBe(true)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { requirementCount: 3 } })
  })

  it('regenerates when the existing summary has zero live (non-deprecated) requirements', async () => {
    const deprecatedOnly = JSON.stringify({
      requirements: [{ id: 'R1', title: 't', text: 'x', pathTypes: ['happy'], deprecated: true }],
      docsHash: 'h',
      sourceDocs: ['prd.md'],
      generatedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json'), deprecatedOnly)
    const d = deps({
      coverage: {
        regenerate: (async (args: { featuresDir: string; feature: string }) => {
          fs.writeFileSync(path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'), summaryJson(1, new Date(Date.now() + 60_000).toISOString()))
          return {} as never
        }) as never,
      },
    })
    const outcome = await prdSummaryStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { requirementCount: 1 } })
  })

  it('fails when regenerate leaves no summary file on disk at all', async () => {
    const d = deps({
      coverage: {
        regenerate: (async () => ({}) as never) as never, // never writes _prd-summary.json
      },
    })
    const outcome = await prdSummaryStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no requirements') })
  })

  it('pins the agent-session ref via onAgentSession during regeneration', async () => {
    fs.mkdirSync(path.join(logsDir, 'flights', 'fl-test', 'prd-summary'), { recursive: true })
    const d = deps({
      now: () => '2026-08-31T07:12:16.374Z',
      coverage: {
        regenerate: (async (args: {
          featuresDir: string
          feature: string
          onAgentSession?: (s: { agent: 'claude' | 'codex'; sessionId: string }) => void
        }) => {
          args.onAgentSession?.({ agent: 'claude', sessionId: 'sess-123' })
          fs.writeFileSync(path.join(args.featuresDir, args.feature, 'docs', '_prd-summary.json'), summaryJson(1, new Date(Date.now() + 60_000).toISOString()))
          return {} as never
        }) as never,
      },
    })
    const { ctx, current } = ctxFor(manifest())
    const outcome = await prdSummaryStage(d).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    const refPath = path.join(logsDir, 'flights', current().flightId, 'prd-summary', 'agent-session.json')
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
    expect(ref.sessions.claude.sessionId).toBe('sess-123')
    expect(current().stages.find((stage) => stage.key === 'prd-summary')?.agentSessions).toEqual([{
      sidecar: 'prd-summary-session-001',
      label: 'Pass 1 · Requirements summary',
      startedAt: '2026-08-31T07:12:16.374Z',
      pass: 1,
    }])
    const historyRef = JSON.parse(fs.readFileSync(path.join(logsDir, 'flights', current().flightId, 'prd-summary-session-001', 'agent-session.json'), 'utf-8'))
    expect(historyRef.sessions.claude.sessionId).toBe('sess-123')
  })
})
