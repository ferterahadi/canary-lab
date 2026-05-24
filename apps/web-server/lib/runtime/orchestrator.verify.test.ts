import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RunOrchestrator } from './orchestrator'
import { runDirFor } from './run-paths'
import { readManifest } from './manifest'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../shared/launcher/types'

let tmpDir: string
let runDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-verify-orch-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), 'verify-run-1')
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

function feature(): FeatureConfig {
  return {
    name: 'checkout',
    description: 'checkout',
    envs: ['production'],
    featureDir: path.join(tmpDir, 'features', 'checkout'),
    repos: [],
  }
}

function exitingPlaywrightFactory(): { factory: PtyFactory; spawned: PtySpawnOptions[] } {
  const spawned: PtySpawnOptions[] = []
  const factory: PtyFactory = (options): PtyHandle => {
    spawned.push(options)
    const data = new EventEmitter()
    const exit = new EventEmitter()
    setTimeout(() => {
      fs.writeFileSync(
        path.join(runDir, 'e2e-summary.json'),
        JSON.stringify({
          complete: true,
          total: 1,
          passed: 1,
          passedNames: ['test-case-loads-home'],
          knownTests: [{ name: 'test-case-loads-home', title: 'loads home' }],
          failed: [],
        }),
      )
      exit.emit('exit', { exitCode: 0 })
    }, 0)
    return {
      pid: 100,
      onData: (cb) => {
        data.on('data', cb)
        return { dispose: () => data.off('data', cb) }
      },
      onExit: (cb) => {
        exit.on('exit', cb)
        return { dispose: () => exit.off('exit', cb) }
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
  return { factory, spawned }
}

describe('RunOrchestrator verification mode', () => {
  it('runs Playwright once without starting services or healing', async () => {
    const { factory, spawned } = exitingPlaywrightFactory()
    const orch = new RunOrchestrator({
      feature: feature(),
      runId: 'verify-run-1',
      runDir,
      ptyFactory: factory,
      executionType: 'verify',
      verification: {
        configName: 'Production',
        playwrightEnvsetId: 'production',
        targetUrls: { default: 'https://example.com' },
        targets: [{ id: 'default', name: 'Default target', url: 'https://example.com' }],
      },
      playwrightEnv: { GATEWAY_URL: 'https://example.com' },
    })

    const status = await orch.runVerification()
    await orch.stop(status)

    expect(status).toBe('passed')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toContain('npx playwright test')
    expect(spawned[0].env).toMatchObject({ GATEWAY_URL: 'https://example.com' })
    const manifest = readManifest(path.join(runDir, 'manifest.json'))
    expect(manifest).toMatchObject({
      executionType: 'verify',
      status: 'passed',
      healCycles: 0,
      services: [],
      verification: {
        configName: 'Production',
        playwrightEnvsetId: 'production',
      },
    })
  })
})
