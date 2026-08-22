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

import { similarityStage } from './similarity'

import { scoutStage } from './scout'

import type { FlightInject, FlightStageDeps } from './context'

import type { StageContext, StageOutcome } from '../conductor'

import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../types'
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

  it('a planned-split flight takes the "new" path without asking — even under yolo (R54)', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const { ctx, current } = ctxFor(manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, plannedSplit: true } }))
    const outcome = await similarityStage(deps()).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { choice: 'new' } })
    expect(current().feature).toBe('checkout') // never re-pointed at the sibling
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

  it('"new" proceeds fresh without re-pointing the flight', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const adapter = similarityStage(deps())
    const { ctx, current, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('similarity', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'new' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { choice: 'new' } })
    expect(current().feature).toBe('checkout')
  })

  it('checkpoint response with no stored match re-runs the scan from scratch', async () => {
    const adapter = similarityStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    setStage('similarity', {
      status: 'waiting-for-approval',
      checkpoint: { kind: 'similarity-choice', message: 'x', options: ['rerun', 'enhance', 'new'], data: {} },
    })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'rerun' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { match: null } })
  })

  it('an unrecognized choice re-parks on the same checkpoint', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const adapter = similarityStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('similarity', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'bogus' })
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'similarity-choice' } })
  })

  it('an entirely missing choice (undefined) with a stored match re-parks too', async () => {
    writeFeatureConfigCjs('existing-checkout', repoDir)
    const adapter = similarityStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('similarity', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'similarity-choice' } })
  })

  it('expands a "~"-prefixed repo path before comparing', async () => {
    // Point HOME at repoDir's parent so a "~/product-repo" feature path must
    // be expanded through os.homedir() to match the real repoDir.
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      writeFeatureConfigCjs('existing-checkout', '~/product-repo')
      const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
      expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'similarity-choice' } })
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it('real() falls back to a resolved (non-realpath) path when the candidate does not exist on disk', async () => {
    // A feature repo pointing at a path that was never created: fs.realpathSync
    // throws, exercising real()'s catch fallback. It still must not equal any
    // of the manifest's real (existing) repoPaths, so the scan reports no match.
    writeFeatureConfigCjs('other-feature', path.join(tmpDir, 'never-created-repo'))
    const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { match: null } })
  })

  it('tolerates a feature config with no repos field at all', async () => {
    const dir = path.join(featuresDir, 'norepos')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      [
        'const config = {',
        "  name: 'norepos',",
        "  description: 'no repos here',",
        "  envs: ['local'],",
        '  featureDir: __dirname,',
        '}',
        'module.exports = { config }',
        '',
      ].join('\n'),
    )
    const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { match: null } })
  })

  it('degrades gracefully when a feature scan hits a broken config (skips it, does not throw)', async () => {
    const dir = path.join(featuresDir, 'broken')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      [
        'const config = {',
        "  name: 'broken',",
        "  description: 'broken feature',",
        "  envs: ['local'],",
        "  repos: [{ name: 'app', localPath: '/tmp/x', startCommands: [{ command: 'npm run dev', healthCheck: {} }] }],",
        '  featureDir: __dirname,',
        '}',
        'module.exports = { config }',
        '',
      ].join('\n'),
    )
    const outcome = await similarityStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { match: null } })
  })
})

describe('scout stage', () => {
  const draftJson = (config: string) =>
    '```json\n' + JSON.stringify({ configSource: config, envFiles: [path.join(repoDir, '.env')] }) + '\n```'

  it('drafts, validates the parse, and settles done — approval parks on scaffold now', async () => {
    const d = deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) })
    const outcome = await scoutStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'done',
      evidence: { configSource: expect.stringContaining('module.exports') },
    })
  })

  it('yolo settles done identically (no checkpoint on scout either way)', async () => {
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

  it('falls back to the default agent spawner when spawnAgent is not injected', async () => {
    const script = path.join(tmpDir, 'fake-claude-scout.sh')
    // The stream-json envelope's `result` is the agent's final answer text —
    // here that text is itself the fenced-JSON draft scout expects.
    const resultText = draftJson(VALID_CONFIG())
    const envelope = JSON.stringify({ type: 'result', result: resultText })
    const b64 = Buffer.from(envelope, 'utf-8').toString('base64')
    fs.writeFileSync(script, `#!/bin/sh\necho '${b64}' | base64 -d\n`)
    fs.chmodSync(script, 0o755)
    const original = process.env.CANARY_LAB_CLAUDE_BIN
    process.env.CANARY_LAB_CLAUDE_BIN = script
    try {
      const outcome = await scoutStage(deps({ spawnAgent: undefined })).run(ctxFor(manifest()).ctx)
      expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('module.exports') } })
    } finally {
      if (original === undefined) delete process.env.CANARY_LAB_CLAUDE_BIN
      else process.env.CANARY_LAB_CLAUDE_BIN = original
    }
  })

  it('treats a non-array envFiles field as none detected', async () => {
    const draftText = '```json\n' + JSON.stringify({ configSource: VALID_CONFIG(), envFiles: 'not-an-array' }) + '\n```'
    const d = deps({ spawnAgent: async () => ({ text: draftText }) })
    const outcome = await scoutStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { envFiles: [] } })
  })

  it('fails when the agent returns an empty configSource', async () => {
    const d = deps({ spawnAgent: async () => ({ text: draftJson('   ') }) })
    const outcome = await scoutStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no configSource') })
  })

  it('carries a redo note for this stage into the prompt, and ignores one aimed elsewhere', async () => {
    // R74: "Continue → from a step…" attaches the note to ONE stage, so the
    // scout prompt must pick it up only when the note is addressed to scout.
    const prompts: string[] = []
    const capture = deps({
      spawnAgent: async ({ prompt }) => { prompts.push(prompt); return { text: draftJson(VALID_CONFIG()) } },
    })

    await scoutStage(capture).run(ctxFor(manifest({ feedback: { stage: 'scout', note: 'you missed the admin repo' } })).ctx)
    expect(prompts[0]).toContain('Feedback on the previous attempt')
    expect(prompts[0]).toContain('you missed the admin repo')

    await scoutStage(capture).run(ctxFor(manifest({ feedback: { stage: 'docs', note: 'wrong docs' } })).ctx)
    expect(prompts[1]).not.toContain('Feedback on the previous attempt')
  })

  // LEGACY release path: manifests that parked on scout's config-approval
  // BEFORE the checkpoint moved to scaffold (remove after one release).
  describe('legacy config-approval release', () => {
    const legacyParked = (draftConfig: string) => {
      const { ctx, setStage } = ctxFor(manifest())
      const draft = { configSource: draftConfig, envFiles: [] }
      setStage('scout', {
        status: 'waiting-for-approval',
        checkpoint: { kind: 'config-approval', message: 'legacy', options: ['approve', 'redraft', 'reject'], data: draft },
      })
      return { ctx }
    }

    it('approve settles the stage with the stored draft as evidence', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve' })
      expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('module.exports') } })
    })

    it('approve accepts a user-edited configSource', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const edited = VALID_CONFIG('checkout-edited')
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve', data: { configSource: edited } })
      expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('checkout-edited') } })
    })

    it('approve with an undecodable data payload keeps the stored draft', async () => {
      // decode failure on the legacy release path is not an error: the edit is
      // simply absent, so the parked draft settles unchanged rather than a
      // string payload being read as `.configSource === undefined`.
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve', data: 'plain prose, no JSON anywhere' })
      expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('module.exports') } })
    })

    it('approve fails when the user-edited configSource does not parse', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'approve', data: { configSource: 'not javascript {{{' } })
      expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('does not parse') })
    })

    it('redraft re-spawns the agent and settles done (scaffold parks the new approval)', async () => {
      let calls = 0
      const adapter = scoutStage(
        deps({
          spawnAgent: async () => {
            calls += 1
            return { text: draftJson(VALID_CONFIG('checkout-redrafted')) }
          },
        }),
      )
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'redraft' })
      expect(outcome).toMatchObject({ kind: 'done', evidence: { configSource: expect.stringContaining('checkout-redrafted') } })
      expect(calls).toBe(1)
    })

    it('reject fails the stage', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'reject' })
      expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('rejected at the approval checkpoint') })
    })

    it('an unrecognized choice re-parks on the same stored checkpoint', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = legacyParked(VALID_CONFIG())
      const outcome = await adapter.onCheckpointResponse!(ctx, {})
      expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'config-approval' } })
    })

    it('a response with no stored checkpoint re-runs the scan from scratch', async () => {
      const adapter = scoutStage(deps({ spawnAgent: async () => ({ text: draftJson(VALID_CONFIG()) }) }))
      const { ctx } = ctxFor(manifest())
      const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'whatever' })
      expect(outcome.kind).toBe('done')
    })
  })
})
