import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import * as featureLoader from '../../../../shared/feature-loader'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'

interface FakeProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  emitData(chunk: string): void
  emitExit(code: number, signal?: number): void
}

function makeFakeFactory(): { factory: PtyFactory; spawned: FakeProcess[] } {
  const spawned: FakeProcess[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakeProcess = {
      pid: nextPid++,
      options,
      data,
      exit,
      killed: null,
      writes: [],
      resizes: [],
      emitData(chunk) { data.emit('data', chunk) },
      emitExit(code, signal) { exit.emit('exit', { exitCode: code, signal }) },
    }
    spawned.push(proc)
    return {
      get pid() { return proc.pid },
      onData: (cb) => {
        data.on('data', cb)
        return { dispose: () => data.off('data', cb) }
      },
      onExit: (cb) => {
        exit.on('exit', cb)
        return { dispose: () => exit.off('exit', cb) }
      },
      write: vi.fn((data: string) => { proc.writes.push(data) }),
      resize: vi.fn((cols: number, rows: number) => {
        proc.resizes.push({ cols, rows })
      }),
      kill: (signal) => { proc.killed = signal ?? 'SIGTERM' },
    }
  }
  return { factory, spawned }
}

let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

describe('RunOrchestrator integration smoke', () => {
  it('full lifecycle: start → service output → signal → restart → stop', async () => {
    vi.useFakeTimers()
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 25,
    })
    const eventLog: string[] = []
    orch.on('service-started', () => eventLog.push('service-started'))
    orch.on('service-output', () => eventLog.push('service-output'))
    orch.on('signal-detected', (e) => eventLog.push(`signal:${e.kind}`))
    orch.on('run-complete', () => eventLog.push('run-complete'))

    await orch.start()
    spawned[0].emitData('boot\n')
    fs.writeFileSync(orch.paths.restartSignal, '')
    await vi.advanceTimersByTimeAsync(30)
    vi.useRealTimers()

    await orch.stop('passed')

    expect(eventLog[0]).toBe('service-started')
    expect(eventLog).toContain('service-output')
    expect(eventLog.at(-1)).toBe('run-complete')
    expect(fs.existsSync(orch.paths.manifestPath)).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'svc-api.log'))).toBe(true)
  })
})

describe('module-helper edge branches', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('defaultHealPrompt echoes guidance and prior-session flags when supplied', async () => {
    const { defaultHealPrompt } = await import('./heal-agent-text')
    const out = defaultHealPrompt({
      cycle: 3,
      outputDir: '/out',
      userGuidance: 'look here',
      priorAgentSessionContext: 'previous claude session context',
    })
    expect(out).toContain('cycle=3')
    expect(out).toContain('guidance="look here"')
    expect(out).toContain('prior-session=true')
  })

  it('extractFailedLocations returns [] when failed is not an array', async () => {
    const { extractFailedLocations } = await import('./run-verdict')
    expect(extractFailedLocations({})).toEqual([])
    expect(extractFailedLocations({ failed: 'nope' as unknown as [] })).toEqual([])
  })

  it('computeVerificationPlan sanitizes malformed knownTests entries and dedupes failedFirst', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'known-sanitize')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeVerificationPlan(featureDir, {
      passedNames: [],
      knownTests: [
        null,
        'string-entry',
        { name: 123, title: 'bad name' },
        { name: '', title: 'empty name' },
        { name: 'test-a', title: 456 },
        { name: 'test-b', title: '' },
        { name: 'test-dup', title: 'Dup' },
        { name: 'test-dup', title: 'Dup second wins-ignored' },
        { name: 'test-pending', title: 'Pending one', titlePath: ['grp', '', 7, 'Pending one'] },
        { name: 'test-failed', title: 'Failed one', location: `${featureDir}/e2e/spec.ts:5` },
      ],
      // Duplicate failed slug proves uniqueByName dedupes failedFirst.
      failed: [{ name: 'test-failed' }, { name: 'test-failed' }],
    })
    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst.map((t) => t.name)).toEqual(['test-failed'])
    expect(result.pending.map((t) => t.name)).toEqual(['test-dup', 'test-pending'])
    // titlePath filtered down to string, non-empty parts only.
    const pendingWithPath = result.pending.find((t) => t.name === 'test-pending')!
    expect(pendingWithPath.titlePath).toEqual(['grp', 'Pending one'])
    if (result.selection.kind !== 'grep') return
    expect(result.selection.grep).toContain('Failed one')
  })

  it('computeVerificationPlan falls back to full-suite when a failed slug is absent from knownTests', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'known-missing')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeVerificationPlan(featureDir, {
      knownTests: [{ name: 'test-known', title: 'Known' }],
      failed: [{ name: 'test-not-in-inventory' }],
    })
    expect(result.kind).toBe('full-suite')
    if (result.kind !== 'full-suite') return
    expect(result.reason).toContain('could not match')
    expect(result.total).toBe(1)
  })

  it('computeVerificationPlan targets summary-provided failed locations when the AST is unavailable', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'no-ast-targeted')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeVerificationPlan(featureDir, {
      total: 5,
      failed: [
        { name: 'a', location: 'e2e/a.spec.ts:10' },
        { name: 'b', location: 'e2e/b.spec.ts:20' },
      ],
    })
    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    if (result.selection.kind !== 'targets') return
    expect(result.selection.targets).toEqual(['e2e/a.spec.ts:10', 'e2e/b.spec.ts:20'])
    expect(result.selection.reason).toContain('full Playwright inventory is unavailable')
  })

  it('computeVerificationPlan falls back to full-suite when summary locations are incomplete', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'no-ast-fullsuite')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeVerificationPlan(featureDir, {
      failed: [
        { name: 'a' },
        { name: 'b', location: 'e2e/b.spec.ts:20' },
      ],
    })
    expect(result.kind).toBe('full-suite')
    if (result.kind !== 'full-suite') return
    expect(result.reason).toContain('without a complete safe selector set')
  })

  it('computeVerificationPlan drops AST-missing failed slugs into a full-suite rerun', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'ast-dropped')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('still here', async () => {})\n",
    )
    const result = computeVerificationPlan(featureDir, {
      // Failed slug for a test that no longer exists in the AST.
      failed: [{ name: 'test-case-renamed-away', location: `${featureDir}/e2e/a.spec.ts:2` }],
    })
    expect(result.kind).toBe('full-suite')
    if (result.kind !== 'full-suite') return
    expect(result.reason).toContain('could not safely target')
  })

  it('computeRerunTargetsOrdered skips unparseable specs but still targets the parseable ones', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'partial-parse')
    fs.mkdirSync(featureDir, { recursive: true })
    // A syntactically-broken spec that yields zero tests is skipped.
    writeSpec(featureDir, 'broken.spec.ts', 'this is (((not valid typescript at all <<<\n')
    const good = writeSpec(featureDir, 'good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('good one', async () => {})\n",
    )
    const result = computeRerunTargetsOrdered(featureDir, { failed: [{ name: 'test-case-good-one', location: `${good}:2` }] })
    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${good}:2`])
  })

  it('computeRerunTargetsOrdered returns extraction-failed when every spec fails to parse', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'all-broken')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'broken.spec.ts', 'nope ((( <<< not valid\n')
    const result = computeRerunTargetsOrdered(featureDir, { failed: [{ name: 'x' }] })
    expect(result.kind).toBe('extraction-failed')
  })

  it('computeNonPassedTargets skips unparseable specs and reports extraction-failed when all fail', async () => {
    const { computeNonPassedTargets } = await import('./run-verdict')
    const partialDir = path.join(tmpDir, 'features', 'npt-partial')
    fs.mkdirSync(partialDir, { recursive: true })
    writeSpec(partialDir, 'broken.spec.ts', 'this ((( is <<< broken\n')
    const good = writeSpec(partialDir, 'good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('one', async () => {})\n" +
      "test('two', async () => {})\n",
    )
    const partial = computeNonPassedTargets(partialDir, { passedNames: ['test-case-one'] })
    expect(partial.kind).toBe('targeted')
    if (partial.kind === 'targeted') expect(partial.locations).toEqual([`${good}:3`])

    const allBrokenDir = path.join(tmpDir, 'features', 'npt-all-broken')
    fs.mkdirSync(allBrokenDir, { recursive: true })
    writeSpec(allBrokenDir, 'broken.spec.ts', 'still ((( broken <<<\n')
    expect(computeNonPassedTargets(allBrokenDir, { passedNames: ['x'] }).kind).toBe('extraction-failed')
  })

  it('readLatestHealOnFailureThreshold falls back to the in-memory threshold when the loader throws', async () => {
    const { readLatestHealOnFailureThreshold } = await import('./run-verdict')
    const spy = vi.spyOn(featureLoader, 'loadFeatures').mockImplementation(() => {
      throw new Error('disk exploded')
    })
    try {
      const feature = makeFeature({ healOnFailureThreshold: 9 })
      expect(readLatestHealOnFailureThreshold(feature)).toBe(9)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('RunOrchestrator.writeToHealAgent', () => {
  it('no-ops with no chunk / no live pty, forwards to the live REPL, and swallows write errors', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'live-agent',
        buildCyclePrompt: () => 'prompt',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))

    // No agent pty yet → early return on the null-pty guard.
    orch.writeToHealAgent('before-spawn')

    const promise = orch.restartHealFromFailure('go')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    const agent = f.spawned[0]

    // Empty chunk → early return (nothing written).
    orch.writeToHealAgent('')
    expect(agent.writes).toEqual([])

    // Live pty → forwarded verbatim.
    orch.writeToHealAgent('keystrokes')
    expect(agent.writes).toContain('keystrokes')

    // A pty that throws mid-write must not surface the error.
    const livePty = (orch as unknown as { ctx: { healAgentPty: { write: (c: string) => void } } }).ctx.healAgentPty
    livePty.write = () => { throw new Error('pty closed') }
    expect(() => orch.writeToHealAgent('after-close')).not.toThrow()

    f.spawned[0].emitExit(0)
    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.interjectHealAgent error path', () => {
  it('returns no-agent-running when the live REPL write throws', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'live-agent',
        buildCyclePrompt: () => 'prompt',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))

    const promise = orch.restartHealFromFailure('go')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    const livePty = (orch as unknown as { ctx: { healAgentPty: { write: (c: string) => void } } }).ctx.healAgentPty
    livePty.write = () => { throw new Error('pty closed') }

    const result = await orch.interjectHealAgent('nudge')
    expect(result).toEqual({ ok: false, reason: 'no-agent-running' })

    f.spawned[0].emitExit(0)
    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.runHealAgent cycle-2 write failure', () => {
  it('returns pty-died when the re-prompt write to the live REPL throws on cycle 2', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      autoHeal: {
        agent: 'claude',
        buildSpawnCommand: () => 'live-agent',
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    await orch.start()

    const first = orch.runHealAgent({ cycle: 1, failedSlugs: ['a'] })
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await first).toMatchObject({ reason: 'signal' })

    // Make the live REPL's stdin write throw so cycle 2's re-prompt fails.
    const livePty = (orch as unknown as { ctx: { healAgentPty: { write: (c: string) => void } } }).ctx.healAgentPty
    livePty.write = () => { throw new Error('pty gone') }
    const second = await orch.runHealAgent({ cycle: 2, failedSlugs: ['a'] })
    expect(second).toEqual({ exitCode: 1, signal: null, reason: 'pty-died' })

    await orch.stop('failed')
  })
})
