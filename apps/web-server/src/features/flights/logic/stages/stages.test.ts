import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'

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
import { scaffoldStage } from './scaffold'
import { envCaptureStage } from './env-capture'
import { docsStage } from './docs'
import { prdSummaryStage } from './prd-summary'
import { buildSpecsPrompt, specsCoverageStage, defaultValidateSpecs, tscErrorsForFeature } from './specs-coverage'
import { portifyStage } from './portify'
import { runStage, healStage } from './run'
import { evaluationExportStage } from './evaluation-export'
import type { FlightInject, FlightStageDeps } from './context'
import { defaultSpawnAgent, extractJson, pollUntil, PollTimeoutError } from './context'
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

function writeFeatureConfigCjs(feature: string, repoLocalPath: string): void {
  const dir = path.join(featuresDir, feature)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), configCjs(feature, repoLocalPath))
}

const VALID_CONFIG = (name = 'checkout') => configCjs(name, '/tmp/x', 'checkout flow')

describe('context helpers', () => {
  function fakeAgentScript(body: string): string {
    const script = path.join(tmpDir, `fake-claude-${Math.random().toString(36).slice(2)}.sh`)
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(script, 0o755)
    return script
  }

  const ORIGINAL_CLAUDE_BIN = process.env.CANARY_LAB_CLAUDE_BIN
  afterEach(() => {
    if (ORIGINAL_CLAUDE_BIN === undefined) delete process.env.CANARY_LAB_CLAUDE_BIN
    else process.env.CANARY_LAB_CLAUDE_BIN = ORIGINAL_CLAUDE_BIN
  })

  describe('defaultSpawnAgent', () => {
    it('recovers the final text on a clean exit and writes the agent-session ref', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo \'{"type":"result","result":"hello from claude"}\'')
      const stageDir = path.join(tmpDir, 'stage-ok')
      fs.mkdirSync(stageDir, { recursive: true })
      const result = await defaultSpawnAgent({ prompt: 'do the thing', cwd: tmpDir, stageDir })
      expect(result.text).toBe('hello from claude')
      const ref = JSON.parse(fs.readFileSync(path.join(stageDir, 'agent-session.json'), 'utf-8'))
      expect(ref.activeAgent).toBe('claude')
      expect(ref.sessions.claude.sessionId).toEqual(expect.any(String))
    })

    it('forwards stderr chunks to onChunk', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo "warn: something" 1>&2\necho \'{"type":"result","result":"ok"}\'')
      const stageDir = path.join(tmpDir, 'stage-stderr')
      fs.mkdirSync(stageDir, { recursive: true })
      const chunks: string[] = []
      const result = await defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, onChunk: (t) => chunks.push(t) })
      expect(result.text).toBe('ok')
      expect(chunks.join('')).toContain('warn: something')
    })

    it('throws when the agent exits non-zero with no recoverable text', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo "boom" 1>&2\nexit 7')
      const stageDir = path.join(tmpDir, 'stage-fail')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })).rejects.toThrow(/agent exited with code 7/)
    })

    it('throws a plain message (no stderr excerpt) when the agent exits non-zero silently', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('exit 9')
      const stageDir = path.join(tmpDir, 'stage-fail-silent')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })).rejects.toThrow('agent exited with code 9')
    })

    it('falls back to "null" in the error message when the agent is killed by a signal (no exit code)', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('kill -TERM $$\nsleep 5')
      const stageDir = path.join(tmpDir, 'stage-fail-signal')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })).rejects.toThrow('agent exited with code null')
    })

    it('does not throw when the agent exits non-zero but still produced usable text', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo \'{"type":"result","result":"partial answer"}\'\nexit 3')
      const stageDir = path.join(tmpDir, 'stage-partial')
      fs.mkdirSync(stageDir, { recursive: true })
      const result = await defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })
      expect(result.text).toBe('partial answer')
    })

    it('throws StageCancelledError immediately when the signal is already aborted (never spawns)', async () => {
      const stageDir = path.join(tmpDir, 'stage-pre-aborted')
      fs.mkdirSync(stageDir, { recursive: true })
      const controller = new AbortController()
      controller.abort()
      await expect(
        defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, signal: controller.signal }),
      ).rejects.toThrow('agent spawn cancelled by flight pause/abort')
      // Never spawned — no agent-session ref was ever written.
      expect(fs.existsSync(path.join(stageDir, 'agent-session.json'))).toBe(false)
    })

    it('throws StageCancelledError when the signal is aborted mid-flight (SIGTERMs the agent)', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('sleep 5')
      const stageDir = path.join(tmpDir, 'stage-abort-midflight')
      fs.mkdirSync(stageDir, { recursive: true })
      const controller = new AbortController()
      const result = defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, signal: controller.signal })
      controller.abort()
      await expect(result).rejects.toThrow('agent spawn cancelled by flight pause/abort')
    })
  })

  describe('extractJson', () => {
    it('parses a fenced JSON block', () => {
      expect(extractJson<{ a: number }>('here:\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 })
    })

    it('falls back to bare braces when there is no fence', () => {
      expect(extractJson<{ a: number }>('answer is {"a":2} done')).toEqual({ a: 2 })
    })

    it('recovers the fenced JSON even when a later turn only adds prose', () => {
      // All-turns transcript: config fence first, then a chatter sign-off with
      // no fence. The fence must still win (the crash this fixed).
      const transcript = 'here is the config:\n```json\n{"a":3}\n```\nAlready delivered the final JSON above — that trailing find was leftover.'
      expect(extractJson<{ a: number }>(transcript)).toEqual({ a: 3 })
    })

    it('prefers the LAST fence when several are present', () => {
      const transcript = '```json\n{"a":1}\n```\nreasoning…\n```json\n{"a":2}\n```'
      expect(extractJson<{ a: number }>(transcript)).toEqual({ a: 2 })
    })

    it('throws with an excerpt when nothing parses', () => {
      expect(() => extractJson('no json here at all')).toThrow(/did not return parseable JSON/)
    })
  })

  describe('pollUntil', () => {
    it('throws PollTimeoutError when the deadline passes before settling', async () => {
      await expect(
        pollUntil(async () => 'pending', () => false, { what: 'thing', timeoutMs: 1, intervalMs: 1 }),
      ).rejects.toThrow(PollTimeoutError)
    })

    it('resolves as soon as the predicate settles', async () => {
      let calls = 0
      const value = await pollUntil(
        async () => { calls += 1; return calls },
        (v) => v >= 2,
        { what: 'thing', timeoutMs: 5000, intervalMs: 1 },
      )
      expect(value).toBe(2)
    })

    it('throws StageCancelledError immediately when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        pollUntil(async () => 'x', () => true, { what: 'thing', timeoutMs: 5000, signal: controller.signal }),
      ).rejects.toThrow('thing cancelled by flight pause/abort')
    })

    it('cancels the interval wait immediately when the signal aborts mid-wait', async () => {
      const controller = new AbortController()
      const promise = pollUntil(
        async () => 'pending',
        () => false, // never settles on its own
        { what: 'thing', timeoutMs: 10_000, intervalMs: 10_000, signal: controller.signal },
      )
      // Let the poll loop reach its interval wait (setTimeout + abort listener
      // registered) before aborting — well short of the 10s interval/timeout.
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort()
      await expect(promise).rejects.toThrow('thing cancelled by flight pause/abort')
    })
  })
})

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

  it('fails the stage when the boot verify fails — verdict + structured errorDetail', async () => {
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
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('never passed its health check'),
      errorDetail: { service: 'app', reason: 'health-timeout', logPath: '/tmp/app.log' },
    })
  })

  it('a crashed service reads as a crash — and the stage error carries the service-log tail', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const logPath = path.join(tmpDir, 'svc-app.log')
    fs.writeFileSync(logPath, "Starting daemon\nUnrecognized VM option 'MaxPermSize=512m'\nError: Could not create the Java Virtual Machine.\n")
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        return {
          statusCode: 200,
          body: {
            manifest: {
              status: 'failed',
              services: [{ name: 'app', status: 'timeout' }],
              bootFailure: { service: 'app', safeName: 'app', reason: 'process-exited', detail: 'x', logPath },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('crashed during boot'),
      errorDetail: {
        service: 'app',
        reason: 'process-exited',
        logPath,
        logTail: expect.stringContaining("Unrecognized VM option 'MaxPermSize=512m'"),
      },
    })
  })

  it('queues behind a repo collision and still boots', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') {
        const payload = call.payload as Record<string, unknown>
        if (payload.isolation === 'queue') return { statusCode: 201, body: { runId: 'boot-1' } }
        return { statusCode: 409, body: { type: 'repo_collision_requires_choice', conflictingFeature: 'other' } }
      }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    }, calls)
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
    expect(calls.some((c) => (c.payload as Record<string, unknown>)?.isolation === 'queue')).toBe(true)
  })

  it('fails when the boot request itself is rejected', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: { error: 'bad request' } }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('boot request rejected') })
  })

  it('fails with "unknown" when the boot rejection carries no error field', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('boots cleanly when a queued run has not yet materialized any services', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    let polls = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        polls += 1
        // First poll: still queued with no services yet (must NOT settle).
        // Second poll: running with zero services (nothing to boot) — settles.
        return { statusCode: 200, body: { manifest: { status: polls === 1 ? 'queued' : 'running', services: [] } } }
      }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('keeps polling past a transient response with no manifest at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    let polls = 0
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') {
        polls += 1
        if (polls === 1) return { statusCode: 200, body: {} } // no manifest yet
        return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('a bootFailure with no logPath still yields the verdict, with empty log evidence', async () => {
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
              bootFailure: { service: 'app', safeName: 'app', reason: 'health-timeout', detail: 'x' },
            },
          },
        }
      }
      return { statusCode: 204, body: {} }
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('never passed its health check'),
      errorDetail: { service: 'app', logPath: '', logTail: '' },
    })
  })

  it('boots cleanly when the feature has nothing to boot (remote-URL, zero services)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1' } } })
  })

  it('fails with a generic message when the run ends aborted with no bootFailure or timed-out service', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'aborted', services: [] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('boot run boot-1 ended aborted') })
  })

  it('fails the stage when captureFeatureEnvFiles rejects (e.g. unknown feature)', async () => {
    // No createFeatureSkeleton call — "checkout" is not a known feature.
    const envFile = path.join(repoDir, '.env')
    fs.writeFileSync(envFile, 'API_KEY=secret\n')
    const outcome = await envCaptureStage(deps()).run(ctxFor(withScout(manifest(), [envFile])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('feature not found') })
  })

  it('waive with none of the detected files present still settles done (zero captured)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'waive' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('fails with a health-check message when a service times out with no bootFailure detail', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [{ name: 'app', status: 'timeout' }] } } }
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('never passed its health check') })
  })

  it('tolerates a rejected abort call after boot verify settles (best-effort teardown)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject: FlightInject = async (call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, json: () => ({ runId: 'boot-1' }) }
      if (call.method === 'GET') return { statusCode: 200, json: () => ({ manifest: { status: 'running', services: [] } }) }
      if (call.url.endsWith('/abort')) throw new Error('abort endpoint exploded')
      return { statusCode: 500, json: () => ({ error: 'unstubbed' }) }
    }
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done' })
  })

  it('tolerates a manifest with no services field at all (not just an empty array)', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'boot-1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running' } } } // no services key
      if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
      return undefined
    })
    const outcome = await envCaptureStage(deps({ inject })).run(ctxFor(withScout(manifest(), [])).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { boot: { runId: 'boot-1', services: [] } } })
  })

  it('detectedFiles tolerates a flight with no scout evidence at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const outcome = await envCaptureStage(deps({ inject: bootInject() })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('checkpoint response tolerates a stage with no checkpoint data at all', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const adapter = envCaptureStage(deps({ inject: bootInject() }))
    const { ctx } = ctxFor(withScout(manifest(), []))
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'done', evidence: { captured: 0 } })
  })

  it('checkpoint response with neither values nor waive re-runs from scratch', async () => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    const missing = path.join(repoDir, '.env')
    const adapter = envCaptureStage(deps())
    const { ctx, setStage } = ctxFor(withScout(manifest(), [missing]))
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('env-capture', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'missing-env' } })
  })
})

describe('docs stage', () => {
  beforeEach(() => {
    createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
    fs.mkdirSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true })
  })

  it('parks even when docs already exist — with `continue` as the release (requirements always pause)', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const outcome = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', options: expect.arrayContaining(['continue']) },
    })
  })

  it('continue releases the checkpoint with the present docs', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'user-confirmed', docs: ['prd.md'] } })
  })

  it('continue with no docs present re-parks instead of settling empty', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome.kind).toBe('checkpoint')
  })

  it('yolo with existing docs settles done without parking', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'existing' } })
  })

  it('symlinks a local doc path referenced in the intent into docs/ (rung 0.5)', async () => {
    const prdPath = path.join(tmpDir, 'external-prd.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ description: `test checkout, refer to ${prdPath}` })
    const parked = await docsStage(deps()).run(ctxFor(m).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { linked: string[] }).linked.length).toBe(1)
    const dest = path.join(featuresDir, 'checkout', 'docs', 'external-prd.md')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(dest, 'utf-8')).toContain('External PRD')
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

  it('parks on prd-source otherwise; a drop while parked releases via continue', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect(parked.checkpoint.kind).toBe('prd-source')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'dropped.md'), '# Dropped PRD')
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'continue' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'user-confirmed', docs: ['dropped.md'] } })
  })

  it('is done immediately when the docs dir does not exist yet (userDocs catch)', async () => {
    fs.rmSync(path.join(featuresDir, 'checkout', 'docs'), { recursive: true, force: true })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('parks on the two-path fork: agent options + the intent in the checkpoint data', async () => {
    const parked = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    // No docs yet → the two agent hints, no continue (nothing to continue with).
    expect(parked.checkpoint.options).toEqual(['collect-repo-docs', 'infer-from-diff'])
    expect((parked.checkpoint.data as { intent: string }).intent).toBe('checkout flow')
  })

  it('parks with continue FIRST once docs exist (the recommended release)', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const parked = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect(parked.checkpoint.options).toEqual(['continue', 'collect-repo-docs', 'infer-from-diff'])
  })

  it('yolo picks up docs/*.md files from the repo, not just READMEs', async () => {
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'docs', 'guide.md'), '# Guide\nDo the thing.')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.some((f) => f.includes('guide'))).toBe(true)
  })

  function initGitRepoWithDiff(): void {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\nworld\n'.repeat(5))
    run(['add', '.'])
    run(['commit', '-qm', 'change'])
  }

  it('infers requirements from the diff vs base when no repo docs exist', async () => {
    initGitRepoWithDiff()
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    // Feature-named artifact (R74) — never a stray repo-derived name.
    expect(docs.some((f) => f.startsWith('checkout-from-diff'))).toBe(true)
    const content = fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', docs.find((f) => f.startsWith('checkout-from-diff'))!), 'utf-8')
    expect(content).toContain('```diff')
  })

  it('honors an explicit base branch override', async () => {
    initGitRepoWithDiff()
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
  })

  it('falls back past a no-op diff (same branch as base) to description-only', async () => {
    initGitRepoWithDiff()
    // Stay on main — current === base, diffVsBase short-circuits to null.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoDir, encoding: 'utf-8' })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('checkpoint response: retry re-runs and re-parks when nothing changed', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'retry' })
    expect(outcome.kind).toBe('checkpoint')
  })

  it('checkpoint response: infer-from-diff spawns the collector agent, which writes the feature-named doc', async () => {
    initGitRepoWithDiff()
    const prompts: string[] = []
    const spawnAgent: FlightStageDeps['spawnAgent'] = async (opts) => {
      prompts.push(opts.prompt)
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-from-diff.md'), '# Derived requirements\n- adds world lines')
      return { text: 'derived requirements from the diff' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'infer-from-diff', feedback: 'skip the refactor noise' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-diff', docs: ['checkout-from-diff.md'] } })
    // The prompt carries the intent, the output path, and the feedback note.
    expect(prompts[0]).toContain('checkout flow')
    expect(prompts[0]).toContain('checkout-from-diff.md')
    expect(prompts[0]).toContain('skip the refactor noise')
  })

  it('checkpoint response: infer-from-diff with no meaningful diff re-parks without spawning', async () => {
    // No git repo at all — detectBaseBranch finds nothing to diff.
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => {
      throw new Error('must not spawn')
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'infer-from-diff' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('No meaningful diff')
  })

  it('checkpoint response: collect-repo-docs settles done when the agent writes the doc', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => {
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md'), '# Requirements\n- does the thing')
      return { text: 'collected from README' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs', docs: ['checkout-prd.md'] } })
  })

  it('checkpoint response: an empty-handed collector re-parks with the NOTHING_FOUND reason', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: repos carry no requirement material' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('repos carry no requirement material')
  })

  it('checkpoint response: an empty-handed collector re-parks with a STRUCTURED attempt', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: no loyalty flow in either repo' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    // The UI keys its verdict band + recommendation flip off this, not off the
    // prose in `message`.
    expect(outcome.checkpoint.data).toMatchObject({
      lastAttempt: { mode: 'collect-repo-docs', outcome: 'empty', reason: 'no loyalty flow in either repo' },
    })
  })

  it('checkpoint response: a reason ending in a period is not double-punctuated', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: the flow does not exist in either repo.' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.message).toContain('does not exist in either repo.')
    expect(outcome.checkpoint.message).not.toContain('repo..')
  })

  it('a rejected attempt logs a TERMINAL line — named attempt, verdict, and the way out', async () => {
    // The activity band is append-only: a rejected attempt sits above whatever
    // ran next. Without "came back empty" + "back to your choice" the line
    // reads as a live failure long after the user has moved on.
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'NOTHING_FOUND: no loyalty flow in either repo' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const log: string[] = []
    ctx.appendLog = (chunk) => { log.push(chunk) }
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })

    const text = log.join('')
    expect(text).toContain('[docs] agent attempt (collect repo docs) — reading the repos guided by the intent…')
    expect(text).toContain('[docs] agent attempt (collect repo docs) came back empty — no loyalty flow in either repo.')
    expect(text).toContain('Back to your choice: add docs yourself, or retry with feedback.')
    // The spawn line must keep its ellipsis — StageActivity splits the band on it.
    expect(log.some((l) => l.trimEnd().endsWith('…'))).toBe(true)
  })

  it('a succeeding attempt says so, so the band reads as a sequence of verdicts', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async (o) => {
      fs.writeFileSync(o.prompt.match(/\/[^\s]*checkout-prd\.md/)![0], '# collected\n')
      return { text: 'done' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const log: string[] = []
    ctx.appendLog = (chunk) => { log.push(chunk) }
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    expect(log.join('')).toContain('agent attempt (collect repo docs) succeeded — wrote docs/checkout-prd.md')
  })

  it('checkpoint response: a collector that writes nothing and says nothing reports no-output', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => ({ text: 'I had a look around.' })
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'collect-repo-docs' })
    if (outcome.kind !== 'checkpoint') throw new Error('expected re-park')
    expect(outcome.checkpoint.data).toMatchObject({ lastAttempt: { outcome: 'no-output' } })
  })

  it('a first visit carries no lastAttempt — the agent path stays the recommendation', async () => {
    const adapter = docsStage(deps())
    const { ctx } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { lastAttempt?: unknown }).lastAttempt).toBeUndefined()
  })

  it('checkpoint response: description-only settles immediately', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'description-only' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('checkpoint response: an unrecognized choice re-runs from scratch', async () => {
    const adapter = docsStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome.kind).toBe('checkpoint')
  })

  it('findRepoDocs ignores non-markdown files under docs/ and stops once MAX_REPO_DOCS is hit', async () => {
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, 'docs', 'notes.txt'), 'not markdown')
    // 12 markdown files across 2 fake "repos" (>MAX_REPO_DOCS=10) to hit the cap.
    const repoDir2 = path.join(tmpDir, 'product-repo-2')
    fs.mkdirSync(path.join(repoDir2, 'docs'), { recursive: true })
    for (let i = 0; i < 12; i += 1) {
      fs.writeFileSync(path.join(repoDir2, 'docs', `d${i}.md`), `# doc ${i}\ncontent`)
    }
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, repoPaths: [repoDir, repoDir2] })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'repo-docs' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => !f.startsWith('_'))
    expect(docs.length).toBeLessThanOrEqual(10)
    expect(docs.some((f) => f.includes('notes'))).toBe(false)
  })

  it('detectBaseBranch follows origin/HEAD when it resolves', async () => {
    initGitRepoWithDiff()
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repoDir })
    // Fake a remote-tracking origin/HEAD pointing at main, without a real remote.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: repoDir })
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repoDir })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
  })

  it('a genuinely empty diff (no file changes) is treated as no-op and falls through', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    run(['commit', '-qm', 'empty change', '--allow-empty']) // current !== base, but the diff itself is empty
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'description-only' } })
  })

  it('a diff over MAX_DIFF_BYTES gets truncated', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    run(['init', '-q', '-b', 'main'])
    run(['config', 'user.email', 't@t.com'])
    run(['config', 'user.name', 't'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), '\n')
    run(['add', '.'])
    run(['commit', '-qm', 'init'])
    run(['checkout', '-qb', 'feature'])
    fs.writeFileSync(path.join(repoDir, 'a.txt'), Array.from({ length: 40000 }, (_, i) => `line number is quite long here indeed ${i}`).join('\n') + '\n')
    run(['add', '.'])
    run(['commit', '-qm', 'huge change'])
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true, base: 'main' } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'diff-vs-base' } })
    const docs = fs.readdirSync(path.join(featuresDir, 'checkout', 'docs')).filter((f) => f.startsWith('checkout-from-diff'))
    const content = fs.readFileSync(path.join(featuresDir, 'checkout', 'docs', docs[0]), 'utf-8')
    expect(content).toContain('…(truncated)')
  })

  it('a write failure (feature not found under its declared config name) fails every write, including repo-docs and the diff-doc one', async () => {
    // Overwrite the scaffolded config's declared `name` so findFeature() (used
    // by writeFeatureDoc) can never resolve "checkout" — every write() call
    // fails: the README write, the diff-vs-base doc write (a real git diff is
    // present so that write is actually attempted), and the final description.
    initGitRepoWithDiff()
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Product\nDoes the thing.')
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'feature.config.cjs'), configCjs('renamed-elsewhere', repoDir))
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'feature not found' })
  })

  it('write() succeeding at a DIFFERENT feature dir than featureDirFor still reports no docs landed', async () => {
    // A feature.config.cjs declaring name "checkout" but living in a
    // differently-named directory: writeFeatureDoc resolves featureDir via the
    // declared name (finds it, writes succeed there), while docsStage's own
    // featureDirFor(deps, 'checkout') is a straight path join that never
    // existed — so the harness-read userDocs() comes back empty.
    fs.rmSync(path.join(featuresDir, 'checkout'), { recursive: true, force: true })
    const otherDir = path.join(featuresDir, 'other-dir')
    fs.mkdirSync(otherDir, { recursive: true })
    fs.writeFileSync(path.join(otherDir, 'feature.config.cjs'), configCjs('checkout', repoDir))
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'no docs landed in features/<f>/docs/' })
  })

  it('legacy use-repo-docs choice degrades to the collect-repo-docs agent path', async () => {
    const spawnAgent: FlightStageDeps['spawnAgent'] = async () => {
      fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'checkout-prd.md'), '# Requirements')
      return { text: 'collected' }
    }
    const adapter = docsStage(deps({ spawnAgent }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('docs', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'use-repo-docs' })
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'agent-repo-docs' } })
  })

  it('userDocs skips a dangling symlink instead of throwing (statSync follows the link)', async () => {
    const docsDir = path.join(featuresDir, 'checkout', 'docs')
    fs.symlinkSync(path.join(tmpDir, 'does-not-exist.md'), path.join(docsDir, 'dangling.md'))
    const outcome = await docsStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', data: { docs: [] } },
    })
  })

  it('intentDocPaths ignores an intent-referenced path that does not exist on disk', async () => {
    const bogus = path.join(tmpDir, 'never-created.md')
    const m = manifest({ description: `test checkout, refer to ${bogus}` })
    const parked = await docsStage(deps()).run(ctxFor(m).ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([])
  })

  it('expands a "~"-prefixed intent doc path before linking it', async () => {
    const originalHome = process.env.HOME
    process.env.HOME = tmpDir
    try {
      const prdPath = path.join(tmpDir, 'home-prd.md')
      fs.writeFileSync(prdPath, '# Home PRD\nthe checkout flow')
      const m = manifest({ description: 'test checkout, refer to ~/home-prd.md' })
      const parked = await docsStage(deps()).run(ctxFor(m).ctx)
      if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
      expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([path.join('docs', 'home-prd.md')])
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it('logs (and skips) when linking an intent doc fails — e.g. the flight points at an unknown feature', async () => {
    const prdPath = path.join(tmpDir, 'external-prd-ghost.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ feature: 'ghost-feature', description: `refer to ${prdPath}` })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({
      kind: 'checkpoint',
      checkpoint: { kind: 'prd-source', data: { linked: [] } },
    })
  })

  it('logs "copied" instead of "linked" when the symlink write falls back to a copy', async () => {
    const prdPath = path.join(tmpDir, 'external-prd-copy.md')
    fs.writeFileSync(prdPath, '# External PRD copy\nthe checkout flow')
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: symlinks unavailable')
    })
    try {
      const m = manifest({ description: `refer to ${prdPath}` })
      const parked = await docsStage(deps()).run(ctxFor(m).ctx)
      if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
      expect((parked.checkpoint.data as { linked: string[] }).linked).toEqual([path.join('docs', 'external-prd-copy.md')])
      const dest = path.join(featuresDir, 'checkout', 'docs', 'external-prd-copy.md')
      expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(dest, 'utf-8')).toContain('External PRD copy')
    } finally {
      symlinkSpy.mockRestore()
    }
  })

  it('yolo with both existing docs AND an intent-linked doc reports "intent-linked" as the source', async () => {
    fs.writeFileSync(path.join(featuresDir, 'checkout', 'docs', 'prd.md'), '# PRD\nreal doc')
    const prdPath = path.join(tmpDir, 'external-prd-yolo.md')
    fs.writeFileSync(prdPath, '# External PRD\nthe checkout flow')
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, description: `refer to ${prdPath}` })
    const outcome = await docsStage(deps()).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { source: 'intent-linked' } })
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

  describe('defaultValidateSpecs (real dry-run: fake npx on PATH)', () => {
    const ORIGINAL_PATH = process.env.PATH

    afterEach(() => {
      process.env.PATH = ORIGINAL_PATH
    })

    // A fake `npx` on PATH that dispatches on its args so we exercise the
    // real spawn/stdout/stderr/close plumbing in tscErrorsForFeature and the
    // playwright --list branch, without invoking the real CLIs.
    function fakeNpxOnPath(behavior: {
      playwright?: { exit: number; stdout?: string }
      tsc?: { exit: number; stdout?: string }
    }): void {
      const binDir = path.join(tmpDir, 'fake-bin')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        'case "$*" in',
        behavior.playwright
          ? `  *"playwright test --list"*) ${behavior.playwright.stdout ? `printf '%s' '${behavior.playwright.stdout.replace(/'/g, "'\\''")}'` : ':'}; exit ${behavior.playwright.exit} ;;`
          : '',
        behavior.tsc
          ? `  *"tsc --noEmit"*) ${behavior.tsc.stdout ? `printf '%s' '${behavior.tsc.stdout.replace(/'/g, "'\\''")}'` : ':'}; exit ${behavior.tsc.exit} ;;`
          : '',
        '  *) exit 0 ;;',
        'esac',
      ].filter(Boolean).join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      process.env.PATH = `${binDir}:${ORIGINAL_PATH}`
    }

    it('reports clean when playwright lists fine and tsc has no tsconfig', async () => {
      fakeNpxOnPath({ playwright: { exit: 0, stdout: '{"suites":[]}' } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('reports clean when tsc exits 0 (no compile errors)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      fakeNpxOnPath({ playwright: { exit: 0, stdout: '{"suites":[]}' }, tsc: { exit: 0 } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('surfaces feature-scoped tsc errors and ignores errors outside the feature dir', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const inFeature = `${path.join(featureDir, 'e2e', 'checkout.spec.ts')}(3,1): error TS2304: Cannot find name 'foo'.`
      const outsideFeature = `${path.join(tmpDir, 'other.ts')}(1,1): error TS1000: unrelated.`
      fakeNpxOnPath({
        playwright: { exit: 0, stdout: '{"suites":[]}' },
        tsc: { exit: 2, stdout: `${inFeature}\n${outsideFeature}\n` },
      })
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.errors).toContain('TS2304')
      expect(result.errors).not.toContain('TS1000')
    })

    it('accumulates tsc errors emitted on stderr too (not just stdout)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const inFeature = `${path.join(featureDir, 'e2e', 'checkout.spec.ts')}(3,1): error TS2304: Cannot find name 'foo'.`
      const binDir = path.join(tmpDir, 'fake-bin-stderr')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        'case "$*" in',
        `  *"playwright test --list"*) printf '%s' '{"suites":[]}'; exit 0 ;;`,
        `  *"tsc --noEmit"*) printf '%s' '${inFeature.replace(/'/g, "'\\''")}\\n' 1>&2; exit 2 ;;`,
        '  *) exit 0 ;;',
        'esac',
      ].join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}:${originalPath}`
      try {
        const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.errors).toContain('TS2304')
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('treats a tsc spawn error (npx not found on PATH) as clean (a missing tool is not a spec failure)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // No fake npx on PATH at all, and PATH cleared entirely — the `spawn('npx', ...)`
      // call itself fails to find the binary, firing the child's 'error' event
      // (as opposed to a non-zero exit code from a found-but-failing binary).
      const originalPath = process.env.PATH
      process.env.PATH = path.join(tmpDir, 'empty-bin-dir')
      fs.mkdirSync(process.env.PATH, { recursive: true })
      try {
        const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
        // playwright --list also fails to spawn (same empty PATH) — that's a
        // real problem — but the tsc side specifically must resolve to null
        // (not compound the error), which this asserts indirectly via ok:false
        // carrying only the playwright message, never a tsc one.
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.errors).not.toContain('tsc --noEmit')
      } finally {
        process.env.PATH = originalPath
      }
    })

    it('treats a non-zero tsc exit with no feature-scoped error lines as clean', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // tsc exits non-zero, but every error line falls outside the feature dir.
      const outsideOnly = `${path.join(tmpDir, 'other.ts')}(1,1): error TS1000: unrelated.`
      fakeNpxOnPath({
        playwright: { exit: 0, stdout: '{"suites":[]}' },
        tsc: { exit: 2, stdout: `${outsideOnly}\n` },
      })
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result).toEqual({ ok: true })
    })

    it('reports a playwright --list failure as a problem', async () => {
      fakeNpxOnPath({ playwright: { exit: 1, stdout: '' } })
      const featureDir = path.join(featuresDir, 'checkout')
      const result = await defaultValidateSpecs({ featureDir, projectRoot: tmpDir })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.errors).toContain('playwright test --list exited with code 1')
    })

    it('kills a hung tsc process at the timeout and treats it as clean (a stuck tool is not a spec failure)', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      const binDir = path.join(tmpDir, 'fake-bin-hang')
      fs.mkdirSync(binDir, { recursive: true })
      const script = [
        '#!/bin/sh',
        // Never exits on its own — only the injected timeout's SIGKILL ends it.
        'sleep 999999',
      ].join('\n')
      const bin = path.join(binDir, 'npx')
      fs.writeFileSync(bin, script + '\n')
      fs.chmodSync(bin, 0o755)
      process.env.PATH = `${binDir}:${ORIGINAL_PATH}`
      // A real (tiny) timeout — no fake-timer/real-child-process races.
      const result = await tscErrorsForFeature(tmpDir, featureDir, 50)
      expect(result).toBeNull()
    })

    it('ignores a late "error" event that arrives after the process already settled', async () => {
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
      const featureDir = path.join(featuresDir, 'checkout')
      // A fake child whose 'close' fires first (settling the promise), then a
      // stray 'error' arrives afterward — the error handler's own settled
      // guard must no-op rather than double-resolve.
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {},
      })
      setMockSpawn(() => fakeChild)
      try {
        const resultPromise = tscErrorsForFeature(tmpDir, featureDir, 60_000)
        fakeChild.emit('close', 0)
        fakeChild.emit('error', new Error('late, after close'))
        const result = await resultPromise
        expect(result).toBeNull()
      } finally {
        setMockSpawn(null)
      }
    })
  })

  it('meets target on the very last post-iteration compute (post-loop check, not the top-of-loop one)', async () => {
    // 1 initial compute + 5 end-of-iteration computes = 6 calls; only the 6th
    // (last) meets target, so the for-loop runs out before its own top-of-loop
    // check ever sees 100% — only the post-loop targetMet(...) check does.
    let calls = 0
    const d = deps({
      spawnAgent: writingSpawnAgent([]),
      validateSpecs: async () => ({ ok: true }),
      coverage: {
        compute: ((() => {
          calls += 1
          return calls >= 6 ? ledger(100) : ledger(0)
        }) as unknown) as never,
        runEngine: (async () => ({}) as never) as never,
      },
    })
    const outcome = await specsCoverageStage(d).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { coveragePct: 100 } })
    expect(calls).toBe(6)
  })

  it('buildSpecsPrompt renders the edit-in-place contract and caps injected validation errors', () => {
    const base = {
      feature: 'checkout',
      description: 'checkout flow',
      configPath: '/abs/features/checkout/feature.config.cjs',
      requirements: [{ id: 'R1' }],
      gaps: [{ id: 'R1', title: 't', gap: 'untested' }],
      featureDir: '/abs/features/checkout',
      iteration: 1,
    }
    const clean = buildSpecsPrompt(base)
    expect(clean).toContain('/abs/features/checkout/e2e')
    expect(clean).toContain('Do NOT reply with JSON')
    expect(clean).not.toContain('failed to compile/list')
    expect(clean).not.toContain('{{')

    const huge = 'x'.repeat(5000) + 'OVERFLOW-MARKER'
    const withErrors = buildSpecsPrompt({ ...base, iteration: 2, validationErrors: huge })
    expect(withErrors).toContain('failed to compile/list')
    expect(withErrors).toContain('xxxx')
    expect(withErrors).not.toContain('OVERFLOW-MARKER')
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

  it('fails when the portify start request is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 400, body: { error: 'no repos' } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('portify start rejected') })
  })

  it('fails with "unknown" when the start rejection carries no error field', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 500, body: {} }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('settles directly via saveAndVerify when the workflow is already saved on first poll', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'saved', diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/save')) { markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { workflowId: 'wf1', edits: true } })
  })

  it('fails when the workflow settles failed with a reason', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'failed', error: 'agent crashed' } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'portify failed: agent crashed' })
  })

  it('fails when the workflow is aborted with no error message', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'aborted' } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: 'portify aborted' })
  })

  it('fails when the save request itself is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status: 'ready-to-save', diff: '' } }
      if (call.url.endsWith('/save')) return { statusCode: 500, body: { error: 'disk full' } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('portify save rejected') })
  })

  it('settles the save-poll via a "failed" status (not just "saved") and still checks the overlay mark', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'failed'; return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    // The save-poll settling on "failed" still falls through to the harness's
    // own overlay-mark check (not the workflow's word for it) — no mark exists.
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('settles the save-poll via an "aborted" status too and still checks the overlay mark', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'aborted'; return { statusCode: 200, body: {} } }
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('fails when save succeeds but the overlay mark never lands', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '' } }
      if (call.url.endsWith('/save')) { status = 'saved'; return { statusCode: 200, body: {} } } // no markPortified()
      return undefined
    })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('overlay mark is missing') })
  })

  it('yolo applies proposed edits without parking on the checkpoint', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/save')) { status = 'saved'; markPortified(); return { statusCode: 200, body: {} } }
      return undefined
    })
    const m = manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true } })
    const outcome = await portifyStage(deps({ inject })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { edits: true } })
  })

  it('checkpoint response: cancel tolerates a rejected cancel-endpoint call (best-effort)', async () => {
    let status = 'ready-to-save'
    const inject: FlightInject = async (call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, json: () => ({ workflowId: 'wf1' }) }
      if (call.method === 'GET') return { statusCode: 200, json: () => ({ status, diff: '--- a/x\n+++ b/x' }) }
      if (call.url.endsWith('/cancel')) throw new Error('cancel endpoint exploded')
      return { statusCode: 500, json: () => ({ error: 'unstubbed' }) }
    }
    const adapter = portifyStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'cancel' })
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('not concurrency-ready') })
  })

  it('checkpoint response: cancel fails the stage and calls the cancel endpoint', async () => {
    const calls: InjectCall[] = []
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      if (call.url.endsWith('/cancel')) return { statusCode: 200, body: {} }
      return undefined
    }, calls)
    const adapter = portifyStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'cancel' })
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('not concurrency-ready') })
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(true)
  })

  it('checkpoint response: an unrecognized choice re-parks on the same checkpoint', async () => {
    let status = 'ready-to-save'
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/portify') return { statusCode: 201, body: { workflowId: 'wf1' } }
      if (call.method === 'GET') return { statusCode: 200, body: { status, diff: '--- a/x\n+++ b/x' } }
      return undefined
    })
    const adapter = portifyStage(deps({ inject }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('portify', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'portify-apply' } })
  })

  it('checkpoint response with no stored workflowId re-runs from scratch', async () => {
    const adapter = portifyStage(deps())
    const { ctx, setStage } = ctxFor(manifest())
    setStage('portify', {
      status: 'waiting-for-approval',
      checkpoint: { kind: 'portify-apply', message: 'x', options: ['apply', 'cancel'], data: {} },
    })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'apply' })
    // Falls through to run(), which starts a fresh workflow via the unstubbed inject (500 → failed).
    expect(outcome.kind).toBe('failed')
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

  it('heal skips when the flight has no run to mirror', async () => {
    const outcome = await healStage(deps()).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no run to mirror' })
  })

  it('heal skips when healCycles is entirely absent from the manifest (not just zero)', async () => {
    const inject = makeInject(() => ({ statusCode: 200, body: { manifest: { status: 'passed', services: [] } } }))
    const withRun = manifest({ links: { runId: 'run-1' } })
    const outcome = await healStage(deps({ inject })).run(ctxFor(withRun).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'run needed no heal' })
  })

  it('heal skips when the linked run has no manifest', async () => {
    const inject = makeInject(() => ({ statusCode: 200, body: {} }))
    const withRun = manifest({ links: { runId: 'run-1' } })
    const outcome = await healStage(deps({ inject })).run(ctxFor(withRun).ctx)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'run run-1 has no manifest' })
  })

  it('queues behind a repo collision and still starts the run', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') {
        const payload = call.payload as Record<string, unknown>
        if (payload.isolation === 'queue') return { statusCode: 201, body: { runId: 'run-1' } }
        return { statusCode: 409, body: { type: 'repo_collision_requires_choice', conflictingFeature: 'other' } }
      }
      if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      return undefined
    }, calls)
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-1', status: 'passed' } })
    expect(calls.some((c) => (c.payload as Record<string, unknown>)?.isolation === 'queue')).toBe(true)
  })

  it('fails when the run start request is rejected', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: { error: 'bad feature' } }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('run start rejected') })
  })

  it('fails with "unknown" when the run start rejection carries no error field', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 400, body: {} }
      return undefined
    })
    const outcome = await runStage(deps({ inject })).run(ctxFor(manifest()).ctx)
    expect(outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('unknown') })
  })

  it('checkpoint response: rerun actually restarts the run', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 1) }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, { choice: 'rerun' })
    // Same stubbed inject always ends "failed" — rerun parks again (proves it re-entered startAndWait).
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed' } })
  })

  it('checkpoint response: an unrecognized choice re-parks on the same checkpoint', async () => {
    const adapter = runStage(deps({ inject: runInject('failed', 1) }))
    const { ctx, setStage } = ctxFor(manifest())
    const parked = await adapter.run(ctx)
    if (parked.kind !== 'checkpoint') throw new Error('expected checkpoint')
    setStage('run', { status: 'waiting-for-approval', checkpoint: parked.checkpoint })
    const outcome = await adapter.onCheckpointResponse!(ctx, {})
    expect(outcome).toMatchObject({ kind: 'checkpoint', checkpoint: { kind: 'run-failed' } })
  })

  it('run() re-attaches to an already-linked runId instead of starting a new run (resume after restart)', async () => {
    const calls: InjectCall[] = []
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-existing') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 1, services: [] } } }
      }
      return undefined // a POST /api/runs here would mean it double-started
    }, calls)
    const m = manifest({ links: { runId: 'run-existing' } })
    const outcome = await runStage(deps({ inject })).run(ctxFor(m).ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-existing', status: 'passed', healCycles: 1 } })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('run() falls through to starting fresh when the previously-linked run no longer exists', async () => {
    const inject = makeInject((call) => {
      if (call.method === 'GET' && call.url === '/api/runs/run-vanished') return { statusCode: 200, body: {} } // no manifest
      if (call.method === 'POST' && call.url === '/api/runs') return { statusCode: 201, body: { runId: 'run-new' } }
      if (call.method === 'GET' && call.url === '/api/runs/run-new') {
        return { statusCode: 200, body: { manifest: { status: 'passed', healCycles: 0, services: [] } } }
      }
      return undefined
    })
    const m = manifest({ links: { runId: 'run-vanished' } })
    const { ctx, current } = ctxFor(m)
    const outcome = await runStage(deps({ inject })).run(ctx)
    expect(outcome).toMatchObject({ kind: 'done', evidence: { runId: 'run-new', status: 'passed' } })
    expect(current().links?.runId).toBe('run-new')
  })

  describe('interrupt (abort hook)', () => {
    it('does nothing on a non-abort interrupt (pause keeps the run alive)', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject(() => undefined, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'pause')
      expect(calls).toHaveLength(0)
    })

    it('does nothing on abort when the flight never linked a run', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject(() => undefined, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest())
      await adapter.interrupt!(ctx, 'abort')
      expect(calls).toHaveLength(0)
    })

    it('does nothing on abort when the linked run has already vanished', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: {} } // no manifest
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
    })

    it('does nothing on abort when the linked run is already terminal', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'passed', services: [] } } }
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(false)
    })

    it('aborts the linked run when it is still active', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((call) => {
        if (call.method === 'GET') return { statusCode: 200, body: { manifest: { status: 'running', services: [] } } }
        if (call.url.endsWith('/abort')) return { statusCode: 204, body: {} }
        return undefined
      }, calls)
      const adapter = runStage(deps({ inject }))
      const { ctx } = ctxFor(manifest({ links: { runId: 'run-1' } }))
      await adapter.interrupt!(ctx, 'abort')
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/run-1/abort')).toBe(true)
    })
  })
})

describe('evaluation-export stage', () => {
  /** Non-yolo flights park on export-mode first; these mechanics tests run
   *  yolo (raw) — the checkpoint itself is covered below. */
  const yoloRun = (links?: { runId?: string; evaluationZip?: string }) =>
    manifest({ opts: { env: 'local', coverageTarget: 100, yolo: true }, ...(links ? { links } : {}) })

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

describe('stage reset (R78 restart wipe)', () => {
  type PublishedEvent = { type: string; feature?: string; taskId?: string }
  function eventSink(): { events: PublishedEvent[]; publisher: { publish: (e: PublishedEvent) => void } } {
    const events: PublishedEvent[] = []
    return { events, publisher: { publish: (e) => events.push(e) } }
  }

  describe('scaffold.reset', () => {
    it('deletes the feature dir + marker when the marker proves this flight created it', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const { ctx } = ctxFor(manifest())
      fs.mkdirSync(ctx.flightDir, { recursive: true })
      fs.writeFileSync(path.join(ctx.flightDir, 'scaffolded-feature'), 'checkout')
      const { events, publisher } = eventSink()

      await scaffoldStage(deps({ workspaceEvents: publisher })).reset!(ctx)

      expect(fs.existsSync(featureDir)).toBe(false)
      expect(fs.existsSync(path.join(ctx.flightDir, 'scaffolded-feature'))).toBe(false)
      expect(events).toContainEqual({ type: 'feature-deleted', feature: 'checkout' })
    })

    it('leaves a PRE-EXISTING feature alone (no marker — the enhance path)', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const { ctx } = ctxFor(manifest())
      const { events, publisher } = eventSink()

      await scaffoldStage(deps({ workspaceEvents: publisher })).reset!(ctx)

      expect(fs.existsSync(featureDir)).toBe(true)
      expect(events).toEqual([])
    })

    it('leaves a feature alone when the marker names a DIFFERENT feature', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const { ctx } = ctxFor(manifest())
      fs.mkdirSync(ctx.flightDir, { recursive: true })
      fs.writeFileSync(path.join(ctx.flightDir, 'scaffolded-feature'), 'other-feature')

      await scaffoldStage(deps()).reset!(ctx)

      expect(fs.existsSync(path.join(featuresDir, 'checkout'))).toBe(true)
    })
  })

  describe('env-capture.reset', () => {
    it("removes the captured envset for the flight's env", async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const envsetDir = path.join(featuresDir, 'checkout', 'envsets', 'local')
      fs.mkdirSync(envsetDir, { recursive: true })
      fs.writeFileSync(path.join(envsetDir, '.env'), 'API_KEY=secret\n')
      const { events, publisher } = eventSink()

      await envCaptureStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(envsetDir)).toBe(false)
      expect(events).toContainEqual({ type: 'envsets-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature dir is already gone', async () => {
      const { events, publisher } = eventSink()
      await envCaptureStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })
  })

  describe('docs.reset', () => {
    it('wipes the ENTIRE docs dir — user files, symlinks, generated artifacts (user ruling)', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const docsDir = path.join(featuresDir, 'checkout', 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      const userPrd = path.join(tmpDir, 'my-own-prd.md')
      fs.writeFileSync(userPrd, '# my prd\n')
      fs.writeFileSync(path.join(docsDir, 'hand-added.md'), '# notes\n')
      fs.symlinkSync(userPrd, path.join(docsDir, 'my-own-prd.md'))
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{}')
      const { events, publisher } = eventSink()

      await docsStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(docsDir)).toBe(false)
      // The symlink TARGET (the user's own file) is never touched.
      expect(fs.existsSync(userPrd)).toBe(true)
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when there is no docs dir', async () => {
      const { events, publisher } = eventSink()
      await docsStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })
  })

  describe('prd-summary.reset', () => {
    it('clears the PRD summary artifacts but keeps user docs', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const docsDir = path.join(featuresDir, 'checkout', 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, 'hand-added.md'), '# notes\n')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{"requirements":[]}')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.md'), '# summary\n')
      const { events, publisher } = eventSink()

      await prdSummaryStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.existsSync(path.join(docsDir, '_prd-summary.json'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, '_prd-summary.md'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, 'hand-added.md'))).toBe(true)
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature is already gone (redo wiped it earlier in the pass)', async () => {
      await expect(prdSummaryStage(deps()).reset!(ctxFor(manifest()).ctx)).resolves.toBeUndefined()
    })
  })

  describe('specs-coverage.reset', () => {
    it('deletes every authored spec (incl. the seed) and the coverage state — but keeps the PRD summary', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const e2eDir = path.join(featureDir, 'e2e')
      fs.mkdirSync(e2eDir, { recursive: true })
      fs.writeFileSync(path.join(e2eDir, 'authored.spec.ts'), '// spec\n')
      const docsDir = path.join(featureDir, 'docs')
      fs.mkdirSync(docsDir, { recursive: true })
      fs.writeFileSync(path.join(docsDir, '_coverage-state.json'), '{}')
      fs.writeFileSync(path.join(docsDir, '_coverage-mappings.json'), '{}')
      fs.writeFileSync(path.join(docsDir, '_prd-summary.json'), '{"requirements":[]}')
      const { events, publisher } = eventSink()

      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      const specs = fs.existsSync(e2eDir) ? fs.readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts')) : []
      expect(specs).toEqual([])
      expect(fs.existsSync(path.join(docsDir, '_coverage-state.json'))).toBe(false)
      expect(fs.existsSync(path.join(docsDir, '_coverage-mappings.json'))).toBe(false)
      // An EARLIER stage's artifact — a restart at specs-coverage must not touch it.
      expect(fs.existsSync(path.join(docsDir, '_prd-summary.json'))).toBe(true)
      expect(events).toContainEqual({ type: 'tests-changed', feature: 'checkout' })
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    })

    it('is a no-op when the feature dir is already gone', async () => {
      const { events, publisher } = eventSink()
      await specsCoverageStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)
      expect(events).toEqual([])
    })
  })

  describe('portify.reset', () => {
    it('restores the pre-portify config from its snapshot and drops the overlay', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const original = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
      const overlayDir = path.join(featureDir, 'portify')
      fs.mkdirSync(overlayDir, { recursive: true })
      fs.writeFileSync(
        path.join(overlayDir, 'meta.json'),
        JSON.stringify({ version: 1, repos: [{ name: 'app', patchFile: 'app.patch', baseCommit: 'abc' }] }),
      )
      fs.writeFileSync(path.join(overlayDir, 'original-config.snapshot'), original)
      fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), original + '\n// portified\n')
      const { events, publisher } = eventSink()

      await portifyStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe(original)
      expect(fs.existsSync(overlayDir)).toBe(false)
      expect(events).toContainEqual({ type: 'features-changed' })
    })

    it('is a no-op when no overlay exists', async () => {
      createFeatureSkeleton({ projectRoot: tmpDir, featuresDir, feature: 'checkout', envs: ['local'] })
      const featureDir = path.join(featuresDir, 'checkout')
      const original = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
      const { events, publisher } = eventSink()

      await portifyStage(deps({ workspaceEvents: publisher })).reset!(ctxFor(manifest()).ctx)

      expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe(original)
      expect(events).toEqual([])
    })
  })

  describe('run.reset', () => {
    it('aborts a live run, then deletes the record through the runs route', async () => {
      let aborted = false
      const calls: InjectCall[] = []
      const inject = makeInject((c) => {
        if (c.method === 'GET' && c.url === '/api/runs/r1') {
          return { statusCode: 200, body: { manifest: { status: aborted ? 'aborted' : 'running' } } }
        }
        if (c.method === 'POST' && c.url === '/api/runs/r1/abort') {
          aborted = true
          return { statusCode: 200, body: {} }
        }
        if (c.method === 'DELETE' && c.url === '/api/runs/r1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await runStage(deps({ inject })).reset!(ctxFor(manifest({ links: { runId: 'r1' } })).ctx)

      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/r1/abort')).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/runs/r1')).toBe(true)
    })

    it('deletes a terminal run record without aborting', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((c) => {
        if (c.method === 'GET' && c.url === '/api/runs/r1') {
          return { statusCode: 200, body: { manifest: { status: 'passed' } } }
        }
        if (c.method === 'DELETE' && c.url === '/api/runs/r1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await runStage(deps({ inject })).reset!(ctxFor(manifest({ links: { runId: 'r1' } })).ctx)

      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/runs/r1/abort')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/runs/r1')).toBe(true)
    })

    it('is a no-op without a runId link', async () => {
      const calls: InjectCall[] = []
      await runStage(deps({ inject: makeInject(() => undefined, calls) })).reset!(ctxFor(manifest()).ctx)
      expect(calls).toEqual([])
    })
  })

  describe('evaluation-export.reset', () => {
    it('deletes the export task through the evaluation route', async () => {
      const calls: InjectCall[] = []
      const inject = makeInject((c) => {
        if (c.method === 'DELETE' && c.url === '/api/evaluation-exports/t1') return { statusCode: 204, body: '' }
        return undefined
      }, calls)

      await evaluationExportStage(deps({ inject })).reset!(
        ctxFor(manifest({ links: { runId: 'r1', evaluationTaskId: 't1' } })).ctx,
      )

      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/evaluation-exports/t1')).toBe(true)
    })

    it('is a no-op without an evaluationTaskId link', async () => {
      const calls: InjectCall[] = []
      await evaluationExportStage(deps({ inject: makeInject(() => undefined, calls) })).reset!(
        ctxFor(manifest({ links: { runId: 'r1' } })).ctx,
      )
      expect(calls).toEqual([])
    })
  })
})

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
