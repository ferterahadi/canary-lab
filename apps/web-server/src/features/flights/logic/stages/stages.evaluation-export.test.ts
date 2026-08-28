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

import { evaluationExportStage } from './evaluation-export'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'

import { readEvaluationExportTask, writeEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'
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

describe('evaluation-export stage', () => {
  /** Non-yolo flights park on export-mode first; these mechanics tests run
   *  yolo (raw) — the checkpoint itself is covered below. */
  const yoloRun = (links?: { runId?: string; evaluationZip?: string }) =>
    manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, ...(links ? { links } : {}) })

  it('teardown aborts the linked export task without erasing it', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject(() => ({ statusCode: 202, body: { aborted: true } }), calls)
    const m = manifest({ links: { runId: 'run-1', evaluationTaskId: 'task-9' } })
    await evaluationExportStage(deps({ inject })).teardown(ctxFor(m).ctx)!.stop('pause')
    // The abort route, not the DELETE: a paused flight must leave the record and
    // its log there to read.
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/evaluation-exports/task-9/abort')).toBe(true)
  })

  it('parks on export-mode (raw vs localized) before starting, non-yolo', async () => {
    const outcome = await evaluationExportStage(deps()).run(ctxFor(manifest({ links: { runId: 'run-1' } })).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'export-mode', options: ['raw', 'localized'], data: { runId: 'run-1' } },
    })
  })

  it('the chosen mode is passed through to the export engine', async () => {
    const calls: InjectCall[] = []
    const taskDir = path.join(logsDir, 'evaluation-exports', 'eval-task-loc')
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-loc',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'localized',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: true,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
        } as never)
        fs.writeFileSync(path.join(taskDir, 'export.zip'), 'PK')
        return { statusCode: 202, body: { taskId: 'eval-task-loc' } }
      }
      return undefined
    }, calls)
    const adapter = evaluationExportStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(manifest({ links: { runId: 'run-1' } }))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'localized' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { mode: 'localized' } })
    const start = calls.find((c) => c.url.endsWith('/evaluation-export'))
    expect(start?.payload).toMatchObject({ mode: 'localized' })
  })

  it('an unrecognized export-mode choice re-parks', async () => {
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(manifest({ links: { runId: 'run-1' } }))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'shiny' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'export-mode' } })
  })

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
    const { ctx, current } = ctxFor(yoloRun({ runId: 'run-1' }))
    const outcome = await evaluationExportStage(deps({ inject })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { taskId: 'eval-task-1' } })
    expect(current().links?.evaluationZip).toBe(path.join(taskDir, 'export.zip'))
  })

  it('fails without a run and reuses an existing archive on resume', async () => {
    const noRun = await evaluationExportStage(deps()).run(ctxFor(manifest()).ctx)
    expect(noRun).toMatchObject({ kind: 'failed', error: expect.stringContaining('no run') })

    const zip = path.join(tmpDir, 'export.zip')
    fs.writeFileSync(zip, 'PK')
    const m = yoloRun({ runId: 'run-1', evaluationZip: zip })
    const reused = await evaluationExportStage(deps()).run(ctxFor(m).ctx)
    expect(reused).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })

  it('fails when the export-start request is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) return { statusCode: 400, body: { error: 'bad mode' } }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('evaluation export rejected') })
  })

  it('fails when the started response carries no taskId', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) return { statusCode: 202, body: {} }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('evaluation export rejected') })
  })

  it('fails when the task settles without downloadReady', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-2',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'raw',
          status: 'failed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: false,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
          error: 'zip step exploded',
        } as never)
        return { statusCode: 202, body: { taskId: 'eval-task-2' } }
      }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('zip step exploded') })
  })

  it('settles on a bare error field even when status is still "running"', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-4',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'raw',
          status: 'running',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: false,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
          error: 'archiver crashed mid-stream',
        } as never)
        return { statusCode: 202, body: { taskId: 'eval-task-4' } }
      }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'evaluation export failed: archiver crashed mid-stream' })
  })

  it('falls back to "unknown" when a failed task carries neither error nor a useful status', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-5',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'raw',
          status: 'failed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: false,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
        } as never)
        return { statusCode: 202, body: { taskId: 'eval-task-5' } }
      }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'evaluation export failed: failed' })
  })

  it('fails when the task reports ready but the archive is missing on disk', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-3',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'raw',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: true,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
        } as never)
        // Deliberately no export.zip written to disk.
        return { statusCode: 202, body: { taskId: 'eval-task-3' } }
      }
      return undefined
    })
    const outcome = await evaluationExportStage(deps({ inject })).run(ctxFor(yoloRun({ runId: 'run-1' })).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no archive at') })
  })

  it('onCheckpointResponse fails cleanly when there is no run to export (state without a runId)', async () => {
    const adapter = evaluationExportStage(deps())
    const { ctx } = ctxFor(manifest()) // no links.runId at all
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'raw' })
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no run to export') })
  })

  it('onCheckpointResponse re-parks on export-mode when the response carries no choice at all', async () => {
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(manifest({ links: { runId: 'run-1' } }))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'export-mode' } })
  })
})

describe('evaluation-export — external producer', () => {
  const externalManifest = (over: Partial<FlightManifest> = {}) =>
    manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, stageProducer: 'external' },
      links: { runId: 'run-1' },
      currentStage: 'evaluation-export',
      ...over,
    })

  /** A minimal REAL run record — getRunDetail reads manifest + e2e-summary off
   *  disk, and the packet's one-test roster comes from the summary names. */
  const writeRunRecord = (runId = 'run-1'): void => {
    const dir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      runId,
      feature: 'checkout',
      featureDir: path.join(featuresDir, 'checkout'),
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    }))
    fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify({
      complete: true, total: 1, passed: 1, passedNames: ['checkout works'], failed: [],
    }))
  }

  const parkOf = (outcome: StageOutcome) => {
    expect(outcome.kind).toBe('checkpoint')
    const cp = (outcome as Extract<StageOutcome, { kind: 'checkpoint' }>).checkpoint
    return { kind: cp.kind, data: (cp.data ?? {}) as Record<string, unknown> }
  }

  const ONE_CASE_REWRITE = {
    summary: 'the checkout works',
    cases: [{ title: 'checkout works', whatWasChecked: 'the flow', whyItMatters: 'revenue', confidence: 'high' }],
  }

  it('yolo + external defaults to localized and hands the rewrite off — work delivery, not an ask', async () => {
    writeRunRecord()
    const { ctx, current } = ctxFor(externalManifest({
      opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' },
      externalAgentSession: {
        clientKind: 'claude',
        sessionId: 'claude-session-1',
        conversationName: 'export checkout',
        sessionUrl: 'https://claude.ai/chat/1',
      },
    }))
    const cp = parkOf(await evaluationExportStage(deps()).run(ctx))
    expect(cp.kind).toBe('external-work')
    expect(cp.data.stage).toBe('evaluation-export')
    // The internal rewrite agent's own prompt (evaluation-rewrite.md).
    expect(String(cp.data.prompt)).toContain('Rewrite the human-facing text slots')
    const context = cp.data.context as { taskId: string; caseCount: number }
    expect(context.caseCount).toBe(1)
    // A real external task record backs the hand-off, linked for resume/cleanup.
    expect(current().links?.evaluationTaskId).toBe(context.taskId)
    expect(readEvaluationExportTask(logsDir, context.taskId)).toMatchObject({
      producer: 'external',
      mode: 'localized',
      sessionId: 'claude-session-1',
      clientKind: 'claude',
      conversationName: 'export checkout',
      externalSessionUrl: 'https://claude.ai/chat/1',
    })
  })

  it('non-yolo external still parks the export-mode ASK first — only the default moved', async () => {
    const outcome = await evaluationExportStage(deps()).run(ctxFor(externalManifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'export-mode' } })
  })

  it('choosing raw under an external producer stays internal and deterministic', async () => {
    const calls: InjectCall[] = []
    const taskDir = path.join(logsDir, 'evaluation-exports', 'eval-task-raw')
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-raw',
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
        return { statusCode: 202, body: { taskId: 'eval-task-raw' } }
      }
      return undefined
    }, calls)
    const adapter = evaluationExportStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(externalManifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'raw' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { mode: 'raw' } })
    expect(calls.find((c) => c.url.endsWith('/evaluation-export'))?.payload).toMatchObject({ mode: 'raw' })
  })

  it('choosing localized under an external producer hands off instead of spawning', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalManifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const cp = parkOf(await adapter.onCheckpointResponse!(ctx, { choice: 'localized' }))
    expect(cp.kind).toBe('external-work')
  })

  it('a valid cases envelope renders through the canonical export and settles on the zip on disk', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage, current } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' } }))
    // Park through the real emitter so the taskId in context is a real record.
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
      data: ONE_CASE_REWRITE,
    })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { mode: 'localized' } })
    const zip = current().links?.evaluationZip
    expect(zip && fs.existsSync(zip)).toBe(true)
  })

  it('a wrong case count re-parks with the expected count, reusing the SAME task', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' } }))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    const taskId = ((parked.checkpoint.data ?? {}) as { context?: { taskId?: string } }).context?.taskId
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const cp = parkOf(await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
      data: { summary: 's', cases: [...ONE_CASE_REWRITE.cases, ...ONE_CASE_REWRITE.cases] },
    }))
    expect(cp.kind).toBe('external-work')
    expect(String((cp.data.context as { lastRejection: string }).lastRejection)).toContain('exactly 1 case')
    expect((cp.data.context as { taskId: string }).taskId).toBe(taskId)
  })

  it('run-internally degrades to the internal localized export, not the abandoned external task', async () => {
    writeRunRecord()
    const calls: InjectCall[] = []
    const taskDir = path.join(logsDir, 'evaluation-exports', 'eval-task-int')
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url.endsWith('/evaluation-export')) {
        writeEvaluationExportTask(logsDir, {
          taskId: 'eval-task-int',
          runId: 'run-1',
          feature: 'checkout',
          mode: 'localized',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          downloadReady: true,
          archiveBase: 'canary-lab-evaluation-checkout-run-1',
        } as never)
        fs.writeFileSync(path.join(taskDir, 'export.zip'), 'PK')
        return { statusCode: 202, body: { taskId: 'eval-task-int' } }
      }
      return undefined
    }, calls)
    const adapter = evaluationExportStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(externalManifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' } }))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'run-internally' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { taskId: 'eval-task-int', mode: 'localized' } })
    // The fresh INTERNAL task was started; the abandoned external one was not re-attached.
    expect(calls.find((c) => c.url.endsWith('/evaluation-export'))?.payload).toMatchObject({ mode: 'localized' })
  })

  it('discards a submit answering a superseded hand-off', async () => {
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('evaluation-export', {
      checkpoint: { kind: 'external-work', message: 'x', data: { handOffId: 'live-id', context: { taskId: 't1' } } },
    })
    const out = await evaluationExportStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit', token: 'stale-id' })
    expect(out).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { data: { lastRejection: 'stale_submission', handOffId: 'live-id' } },
    })
  })

  it('fails when the hand-off lost its task id', async () => {
    writeRunRecord()
    const { ctx, setStage } = ctxFor(externalManifest())
    setStage('evaluation-export', { checkpoint: { kind: 'external-work', message: 'x', data: { context: {} } } })
    expect(await evaluationExportStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lost its task id'),
    })
  })
})

describe('evaluation-export — external producer edge arms', () => {
  const externalYolo = (over: Partial<FlightManifest> = {}) =>
    manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: true, stageProducer: 'external' },
      links: { runId: 'run-1' },
      currentStage: 'evaluation-export',
      ...over,
    })

  const writeRunRecord = (runId = 'run-1'): void => {
    const dir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      runId, feature: 'checkout', featureDir: path.join(featuresDir, 'checkout'),
      startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:05.000Z',
      status: 'passed', healCycles: 0, services: [],
    }))
    fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify({
      complete: true, total: 1, passed: 1, passedNames: ['checkout works'], failed: [],
    }))
  }

  it('fails the hand-off when the linked run has no record on disk', async () => {
    const out = await evaluationExportStage(deps()).run(ctxFor(externalYolo({ links: { runId: 'run-gone' } })).ctx)
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('has no manifest') })
  })

  it('a prior INTERNAL task in links does not block the hand-off — a fresh external task is minted', async () => {
    writeRunRecord()
    writeEvaluationExportTask(logsDir, {
      taskId: 'eval-int-1',
      runId: 'run-1',
      feature: 'checkout',
      mode: 'localized',
      producer: 'internal',
      status: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      downloadReady: false,
      archiveBase: 'x',
    } as never)
    const { ctx, current } = ctxFor(externalYolo({ links: { runId: 'run-1', evaluationTaskId: 'eval-int-1' } }))
    const out = await evaluationExportStage(deps()).run(ctx)
    expect(out).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'external-work' } })
    expect(current().links?.evaluationTaskId).not.toBe('eval-int-1')
  })

  it('a prior external task that already completed settles without re-parking', async () => {
    writeRunRecord()
    const taskDir = path.join(logsDir, 'evaluation-exports', 'eval-ext-done')
    writeEvaluationExportTask(logsDir, {
      taskId: 'eval-ext-done',
      runId: 'run-1',
      feature: 'checkout',
      mode: 'localized',
      producer: 'external',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      downloadReady: true,
      archiveBase: 'x',
    } as never)
    fs.writeFileSync(path.join(taskDir, 'export.zip'), 'PK')
    const { ctx } = ctxFor(externalYolo({ links: { runId: 'run-1', evaluationTaskId: 'eval-ext-done' } }))
    expect(await evaluationExportStage(deps()).run(ctx)).toMatchObject({
      kind: 'done',
      evidence: { taskId: 'eval-ext-done', mode: 'localized' },
    })
  })

  it('a submit on a hand-off whose flight lost its run link fails plainly', async () => {
    const { ctx, setStage } = ctxFor(externalYolo({ links: undefined }))
    setStage('evaluation-export', { checkpoint: { kind: 'external-work', message: 'x', data: { context: { taskId: 't1' } } } })
    expect(await evaluationExportStage(deps()).onCheckpointResponse!(ctx, { choice: 'submit' })).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no run to export'),
    })
  })

  it('accepts the rewrite as a raw JSON string — the same parse chain as the internal agent output', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalYolo())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const out = await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
      data: JSON.stringify({
        summary: 'ok',
        cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'y', confidence: 'high' }],
      }),
    })
    expect(out).toMatchObject({ kind: 'done', evidence: { mode: 'localized' } })
  })

  it('a submit with no data at all re-parks (nothing usable to judge)', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalYolo())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const out = await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
    })
    expect(out).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'external-work' } })
  })

  it('fails a submit when the run record vanished while parked', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalYolo())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.rmSync(path.join(logsDir, 'runs', 'run-1'), { recursive: true, force: true })
    const out = await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
      data: { summary: 'ok', cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'y', confidence: 'high' }] },
    })
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('has no manifest') })
  })

  it('fails when the task record vanished between the park and the submit', async () => {
    writeRunRecord()
    const adapter = evaluationExportStage(deps())
    const { ctx, setStage } = ctxFor(externalYolo())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    const taskId = ((parked.checkpoint.data ?? {}) as { context?: { taskId?: string } }).context?.taskId
    fs.rmSync(path.join(logsDir, 'evaluation-exports', String(taskId), 'task.json'), { force: true })
    setStage('evaluation-export', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const out = await adapter.onCheckpointResponse!(ctx, {
      choice: 'submit',
      token: ((parked.checkpoint.data ?? {}) as { handOffId?: string }).handOffId,
      data: { summary: 'ok', cases: [{ title: 't', whatWasChecked: 'w', whyItMatters: 'y', confidence: 'high' }] },
    })
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('disappeared mid-submit') })
  })
})
