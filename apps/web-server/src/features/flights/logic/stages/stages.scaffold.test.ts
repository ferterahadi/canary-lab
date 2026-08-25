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

import { scaffoldStage } from './scaffold'

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

describe('scaffold stage', () => {
  function withScoutEvidence(m: FlightManifest, configSource: string): FlightManifest {
    return {
      ...m,
      stages: m.stages.map((s) => (s.key === 'scout' ? { ...s, status: 'done' as const, evidence: { configSource, envFiles: [] } } : s)),
    }
  }

  const yoloManifest = (over: Partial<FlightManifest> = {}) =>
    manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, ...over })

  it('scaffolds the feature, lays the config over the skeleton, and parks on config-approval', async () => {
    const { ctx } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'config-approval', options: ['approve', 'redraft'] },
    })
    const written = fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')
    expect(written).toContain("name: 'checkout'")
    expect(written).toContain('startCommands')
  })

  it('yolo skips the approval checkpoint', async () => {
    const { ctx } = ctxFor(withScoutEvidence(yoloManifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('done')
  })

  it('injects the flight\'s group into the scaffolded config (plan-features batches)', async () => {
    const grouped = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: false, group: 'my-shop' } })
    const { ctx } = ctxFor(withScoutEvidence(grouped, VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('checkpoint')
    const written = fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')
    expect(written).toMatch(/name: 'checkout',\s*\n\s*group: 'my-shop',/)
    // Idempotent on resume: the grouped config is recognized as this flight's own.
    const again = await scaffoldStage(deps()).run(ctx)
    expect(again.kind).toBe('checkpoint')
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')).toBe(written)
  })

  it('approve re-reads the CURRENT on-disk config (edits made while parked count)', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    // The user edited the on-disk config (digest / FeatureConfigEditor) while parked.
    const configPath = path.join(featuresDir, 'checkout', 'feature.config.cjs')
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf-8').replace('startCommands', 'startCommands /* edited */'))
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { approved: true } })
  })

  it('approve re-parks with the parse error when the on-disk config is broken (never fails the flight)', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'not javascript {{{')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'config-approval', data: { error: expect.any(String) } },
    })
  })

  it('a configSource in the response data writes through to disk before validation (MCP/CLI path)', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const edited = VALID_CONFIG('checkout')
      .replace('startCommands', 'startCommands /* via-mcp */')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve', data: { configSource: edited } })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { approved: true } })
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')).toContain('via-mcp')
  })

  // The silent half of the same `data`-encoding bug: a JSON-ENCODED payload read as
  // a bare string, so `.configSource` was undefined and the edit was DROPPED without
  // a word — the config approved was the one already on disk, not the one submitted.
  // Asserted on the file content, because "it did not error" was exactly the old
  // behaviour.
  it('a JSON-ENCODED configSource also writes through to disk', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const edited = VALID_CONFIG('checkout')
      .replace('startCommands', 'startCommands /* via-encoded-mcp */')
    const outcome = await adapter.onCheckpointResponse!(ctx, {
      choice: 'approve',
      data: JSON.stringify({ configSource: edited }),
    })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { approved: true } })
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8'))
      .toContain('via-encoded-mcp')
  })

  it('an undecodable data payload drops the edit and approves the disk config', async () => {
    // The decode-failure arm: a plain-prose payload carries no configSource, so
    // nothing is written through and the config approved is the one on disk.
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const before = fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve', data: 'plain prose, no JSON anywhere' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { approved: true } })
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')).toBe(before)
  })

  it('redraft rewinds to scout for a fresh draft', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'redraft' })
    expect(outcome).toMatchObject({ kind: 'rewind', to: 'scout' })
  })

  it('never overwrites an existing feature — picks a free name and re-points the flight', async () => {
    writeFeatureConfigCjs('checkout', path.join(tmpDir, 'other-repo'))
    const { ctx, current } = ctxFor(withScoutEvidence(yoloManifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('done')
    expect(current().feature).toBe('checkout-2')
    expect(fs.readFileSync(path.join(featuresDir, 'checkout-2', 'feature.config.cjs'), 'utf-8')).toContain("name: 'checkout-2'")
    // The pre-existing feature is untouched.
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), 'utf-8')).toContain('existing feature')
  })

  it('is idempotent on resume', async () => {
    const m = withScoutEvidence(yoloManifest(), VALID_CONFIG())
    const first = ctxFor(m)
    await scaffoldStage(deps()).run(first.ctx)
    const again = await scaffoldStage(deps()).run(first.ctx)
    expect(again).toMatchObject({ kind: 'done', evidence: { reused: true } })
  })

  it('recognizes its own feature via the scaffold marker even after the config was edited', async () => {
    const m = withScoutEvidence(yoloManifest(), VALID_CONFIG())
    const { ctx, current } = ctxFor(m)
    await scaffoldStage(deps()).run(ctx)
    // The user edited the config while the flight was paused — the marker says
    // the feature is this flight's own; no free-name fork.
    const configPath = path.join(featuresDir, 'checkout', 'feature.config.cjs')
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf-8').replace('startCommands', 'startCommands /* edited */'))
    const again = await scaffoldStage(deps()).run(ctx)
    expect(again).toMatchObject({ kind: 'done', evidence: { reused: true } })
    expect(current().feature).toBe('checkout')
  })

  it('fails when there is no scout draft to scaffold from', async () => {
    const { ctx } = ctxFor(manifest())
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no scout draft') })
  })

  it('keeps incrementing the free-name suffix past -2 when it too is taken', async () => {
    writeFeatureConfigCjs('checkout', path.join(tmpDir, 'other-repo'))
    writeFeatureConfigCjs('checkout-2', path.join(tmpDir, 'other-repo-2'))
    const { ctx, current } = ctxFor(withScoutEvidence(yoloManifest(), VALID_CONFIG()))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('done')
    expect(current().feature).toBe('checkout-3')
  })

  it('fails when the scaffolded config does not parse (no locatable config object)', async () => {
    const { ctx } = ctxFor(withScoutEvidence(manifest(), 'module.exports = {}\n'))
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('scaffolded config does not parse') })
  })

  it('fails when createFeatureSkeleton itself rejects (invalid feature name)', async () => {
    const m = withScoutEvidence(manifest({ feature: 'bad name!' }), VALID_CONFIG('bad name!'))
    const { ctx } = ctxFor(m)
    const outcome = await scaffoldStage(deps()).run(ctx)
    expect(outcome.kind).toBe('failed')
  })

  it('approve fails when feature.config.cjs disappeared while parked', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.rmSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'))
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve' })
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('feature.config.cjs disappeared from'),
    })
  })

  it('a "reject" choice fails the stage (legacy clients — no longer offered)', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'reject' })
    expect(outcome).toMatchObject({ kind: 'failed', error: 'config rejected at the approval checkpoint' })
  })

  it('an entirely missing choice re-parks on the same checkpoint', async () => {
    const adapter = scaffoldStage(deps())
    const { ctx, setStage } = ctxFor(withScoutEvidence(manifest(), VALID_CONFIG()))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('scaffold', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'config-approval' } })
  })
})
