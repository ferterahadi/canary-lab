import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RunOrchestrator, type PlaywrightSpawner } from './orchestrator'
import { runDirFor } from './run-paths'
import { readManifest } from './manifest'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../shared/launcher/types'

let tmpDir: string
let runDir: string
const RUN_ID = 'boot-run-1'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-boot-orch-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

function feature(): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo serving', name: 'api', healthCheck: { url: 'http://localhost/' } }],
      },
    ],
  }
}

// A long-lived service pty that never exits on its own — mirrors a real server
// that keeps running until killed.
function makeServiceFactory(): { factory: PtyFactory; spawned: PtySpawnOptions[] } {
  const spawned: PtySpawnOptions[] = []
  const factory: PtyFactory = (options): PtyHandle => {
    spawned.push(options)
    const data = new EventEmitter()
    const exit = new EventEmitter()
    return {
      pid: 200 + spawned.length,
      onData: (cb) => { data.on('data', cb); return { dispose: () => data.off('data', cb) } },
      onExit: (cb) => { exit.on('exit', cb); return { dispose: () => exit.off('exit', cb) } },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
  return { factory, spawned }
}

describe('RunOrchestrator boot-only mode', () => {
  it('boots services and holds them without running Playwright', async () => {
    const { factory, spawned } = makeServiceFactory()
    const playwrightSpawner = vi.fn<PlaywrightSpawner>()
    const orch = new RunOrchestrator({
      feature: feature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      executionType: 'boot',
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner,
    })

    await orch.bootOnly()

    // Playwright never ran; only the service pty was spawned.
    expect(playwrightSpawner).not.toHaveBeenCalled()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toContain('echo serving')

    const manifest = readManifest(path.join(runDir, 'manifest.json'))!
    expect(manifest.executionType).toBe('boot')
    expect(manifest.status).toBe('running')
    expect(manifest.healCycles).toBe(0)
    expect(manifest.healMode).toBeUndefined()
    expect(manifest.services[0]).toMatchObject({ name: 'api', status: 'ready' })
    expect(manifest.lifecycle?.phase).toBe('services-ready')
  })

  it('tears the services down and finalizes on stop', async () => {
    const { factory } = makeServiceFactory()
    const orch = new RunOrchestrator({
      feature: feature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      executionType: 'boot',
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: vi.fn<PlaywrightSpawner>(),
    })

    await orch.bootOnly()
    await orch.stop('aborted')

    const manifest = readManifest(path.join(runDir, 'manifest.json'))!
    expect(manifest.status).toBe('aborted')
    expect(manifest.services[0].status).toBe('stopped')
    // Boot teardown reads as a calm "services stopped", not a failure.
    expect(manifest.lifecycle?.headline).toBe('Services stopped — envset reverted')
  })
})
