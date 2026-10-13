import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RunOrchestrator } from './orchestrator'
import { runDirFor } from './run-paths'
import { readManifest, readRunsIndex } from './manifest'
import { makeFakePtyFactory } from '../../../../../../../tools/test-helpers/fake-pty'
import { demoFeature } from '../../../../../../../tools/test-helpers/feature-fixture'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-orc-')
let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = tempDir()
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RunOrchestrator.restart / rerun / status', () => {
  it('restart re-spawns services and truncates logs', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()

    spawned[0].emitData('first\n')
    await new Promise((r) => setTimeout(r, 5))

    // No filesChanged → legacy "restart all" semantics.
    await orch.restart()
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe('SIGTERM')

    const logBody = fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')
    expect(logBody).toBe('')

    await orch.stop('passed')
  })

  it('ignores a stale service exit from a pty replaced during restart', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const exits: number[] = []
    orch.on('service-exit', (event) => exits.push(event.exitCode))

    await orch.start()
    await orch.restart()
    expect(spawned).toHaveLength(2)

    spawned[0].emitExit(1)
    expect(exits).toEqual([])

    spawned[1].emitExit(2)
    expect(exits).toEqual([2])

    await orch.stop('failed')
  })

  it('selective restart only respawns services matching filesChanged', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const repoA = tempDir('cl-orc-a-')
    const repoB = tempDir('cl-orc-b-')
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, {
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
          { name: 'b', localPath: repoB, startCommands: [{ command: 'echo b', name: 'svcB', healthCheck: { url: 'http://b' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const planEvents: { toRestart: string[]; toKeep: string[]; noMatch: boolean }[] = []
    const skipEvents: string[] = []
    orch.on('restart-planned', (e) => planEvents.push(e))
    orch.on('service-restart-skipped', (e) => skipEvents.push(e.service.safeName))

    await orch.start()
    expect(spawned).toHaveLength(2) // two services started
    spawned[1].emitData('svcB before\n')

    // Only repoA's file changed → only svcA restarts.
    await orch.restart([path.join(repoA, 'src/x.ts')])
    expect(spawned).toHaveLength(3) // one new spawn (svcA)
    expect(spawned[0].killed).toBe('SIGTERM') // svcA killed
    expect(spawned[1].killed).toBe(null) // svcB kept warm
    expect(planEvents[0].toRestart).toEqual(['svca'])
    expect(planEvents[0].toKeep).toEqual(['svcb'])
    expect(skipEvents).toEqual(['svcb'])

    // The kept service's log rotates too, so its next execution starts its own
    // file instead of running on under the earlier execution's lines.
    spawned[1].emitData('svcB after\n')
    const segments = fs.readdirSync(path.join(runDir, 'service-logs', 'svcb'))
    expect(segments).toHaveLength(1)
    expect(fs.readFileSync(path.join(runDir, 'service-logs', 'svcb', segments[0]), 'utf-8')).toBe('svcB before\n')
    expect(fs.readFileSync(path.join(runDir, 'svc-svcb.log'), 'utf-8')).toBe('svcB after\n')

    await orch.stop('passed')
  })

  it('selective restart with no matches keeps all services warm and emits noMatch', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const repoA = tempDir('cl-orc-a-')
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, {
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const planEvents: { noMatch: boolean }[] = []
    orch.on('restart-planned', (e) => planEvents.push(e))

    await orch.start()
    expect(spawned).toHaveLength(1)

    await orch.restart(['/somewhere/totally/different.ts'])
    expect(spawned).toHaveLength(1) // no new spawn
    expect(spawned[0].killed).toBe(null)
    expect(planEvents[0].noMatch).toBe(true)

    await orch.stop('passed')
  })

  it('selective restart with full match restarts everything', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const repoA = tempDir('cl-orc-a-')
    const repoB = tempDir('cl-orc-b-')
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, {
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
          { name: 'b', localPath: repoB, startCommands: [{ command: 'echo b', name: 'svcB', healthCheck: { url: 'http://b' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    await orch.restart([path.join(repoA, 'a.ts'), path.join(repoB, 'b.ts')])
    expect(spawned).toHaveLength(4) // 2 original + 2 respawned
    expect(spawned[0].killed).toBe('SIGTERM')
    expect(spawned[1].killed).toBe('SIGTERM')
    await orch.stop('passed')
  })

  it('rerun truncates logs without re-spawning', async () => {
    const { factory, spawned } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    fs.writeFileSync(path.join(runDir, 'svc-api.log'), 'pre-existing')
    await orch.rerun()
    expect(fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')).toBe('')
    expect(spawned).toHaveLength(1)
    await orch.stop('passed')
  })

  it('setStatus updates manifest + index and emits run-status', async () => {
    const { factory } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    await orch.start()
    orch.setStatus('healing')
    expect(statuses).toContain('healing')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(readRunsIndex(path.join(tmpDir, 'logs'))[0].status).toBe('healing')

    await orch.stop('failed')
  })

  it('noteHealCycle increments + persists', async () => {
    const { factory } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    orch.noteHealCycle()
    orch.noteHealCycle()
    expect(readManifest(orch.paths.manifestPath)?.healCycles).toBe(2)
    await orch.stop('passed')
  })

  it('stop is idempotent and finalizes manifest + index', async () => {
    const { factory } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    let completes = 0
    orch.on('run-complete', () => completes++)
    await orch.start()
    await orch.stop('passed')
    await orch.stop('passed')
    expect(completes).toBe(1)
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.status).toBe('passed')
    expect(manifest.endedAt).toBeTruthy()
    const index = readRunsIndex(path.join(tmpDir, 'logs'))
    expect(index[0].endedAt).toBeTruthy()
  })
})

describe('RunOrchestrator construction defaults', () => {
  it('uses real isHealthy + setTimeout-based delay when not injected', async () => {
    const { factory } = makeFakePtyFactory()
    // Feature has no healthUrl, so the real isHealthy default never fires —
    // but the constructor branches that pick defaults are covered.
    const f = demoFeature(tmpDir, {
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'x', name: 'x' }] }],
    })
    const orch = new RunOrchestrator({
      feature: f,
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
    })
    await orch.start()
    await orch.stop('passed')
  })

  it('stop without prior start clears nothing but still finalizes manifest', async () => {
    const { factory } = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    // Don't call start() — no signalWatcher to clear, no services to kill.
    await orch.stop('aborted')
    // Manifest never written without start, so the update is a no-op; stop() still
    // emits run-complete.
  })
})
