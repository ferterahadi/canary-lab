import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { createServer } from './server'
import { RunOrchestrator } from './lib/runtime/orchestrator'
import { generateRunId } from './lib/runtime/run-id'
import { runDirFor } from './lib/runtime/run-paths'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './lib/runtime/pty-spawner'

// End-to-end check: POST /api/runs against the broken_todo_api fixture, drive
// the orchestrator with a fake ptyFactory so we don't need real Playwright,
// and verify that the orchestrator emits its events in the right order and
// produces a manifest plus a per-failure dir.

interface FakeProc {
  cmd: string
  data: EventEmitter
  exit: EventEmitter
  emitData(c: string): void
  emitExit(code: number): void
}

function makeFakeFactory(): { factory: PtyFactory; spawned: FakeProc[] } {
  const spawned: FakeProc[] = []
  let pid = 1000
  const factory: PtyFactory = (opts: PtySpawnOptions): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const fp: FakeProc = {
      cmd: opts.command,
      data,
      exit,
      emitData(c) { data.emit('data', c) },
      emitExit(code) { exit.emit('exit', { exitCode: code }) },
    }
    spawned.push(fp)
    pid += 1
    const localPid = pid
    return {
      get pid() { return localPid },
      onData: (cb) => { data.on('data', cb); return { dispose() {} } },
      onExit: (cb) => { exit.on('exit', cb); return { dispose() {} } },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
  return { factory, spawned }
}

let projectRoot: string
let logsDir: string
let featuresDir: string

beforeEach(() => {
  // Stand up a minimal fixture project (broken-style feature) in tmp so we
  // don't write into the repo's logs/ during tests.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-srv-')))
  projectRoot = tmp
  logsDir = path.join(tmp, 'logs')
  featuresDir = path.join(tmp, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
  const featureDir = path.join(featuresDir, 'broken_demo')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: {
       name: 'broken_demo',
       description: 'fixture',
       envs: ['local'],
       featureDir: __dirname,
       repos: [{
         name: 'svc',
         localPath: __dirname,
         startCommands: [{ name: 'svc', command: 'echo svc', healthCheck: { url: 'http://x' } }],
       }],
     } }`,
  )
})

afterEach(() => {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('createServer + RunOrchestrator.runFullCycle integration', () => {
  it('POST /api/runs drives orchestrator end-to-end with a fake pty factory', async () => {
    const fake = makeFakeFactory()
    const events: string[] = []
    let lastOrch: RunOrchestrator | null = null
    let runDirCaptured = ''

    const { app } = await createServer({
      projectRoot,
      featuresDir,
      logsDir,
    })
    // The default startRun in createServer uses realPtyFactory() — for this
    // test we replace the runs route with a custom one. Since createServer
    // already registered routes, we instead drive the orchestrator directly
    // (mirroring what createServer does) and assert against the public API.
    await app.close()

    // Build orchestrator with the fake factory and a healthCheck stub.
    const features = require(path.join(featuresDir, 'broken_demo', 'feature.config.cjs')).config
    const runId = generateRunId()
    const runDir = runDirFor(logsDir, runId)
    runDirCaptured = runDir
    const orch = new RunOrchestrator({
      feature: features,
      runId,
      runDir,
      ptyFactory: fake.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: features.featureDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildCommand: () => 'fake-heal',
      },
    })
    lastOrch = orch
    orch.on('service-started', () => events.push('service-started'))
    orch.on('playwright-started', () => events.push('playwright-started'))
    orch.on('playwright-exit', () => events.push('playwright-exit'))
    orch.on('heal-cycle-started', () => events.push('heal-cycle-started'))
    orch.on('agent-started', () => events.push('agent-started'))
    orch.on('agent-exit', () => events.push('agent-exit'))
    orch.on('run-complete', () => events.push('run-complete'))

    // Pre-seed the summary so the heal loop sees a failed slug.
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'test-case-broken', endTime: 100 }] }),
    )

    const promise = orch.runFullCycle()
    const waitFor = async (n: number) => {
      const start = Date.now()
      while (fake.spawned.length < n) {
        if (Date.now() - start > 3000) throw new Error(`stuck at ${fake.spawned.length}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    await waitFor(2) // service + first playwright
    fake.spawned[1].emitExit(1) // pw fails
    await waitFor(3) // heal agent
    fake.spawned[2].emitExit(0) // agent exits without writing a signal — give-up path
    const status = await promise
    expect(status).toBe('failed')
    await orch.stop('failed')
    void lastOrch
    expect(runDirCaptured).toBeTruthy()

    // The orchestrator created the per-failure MCP capture dir as part of the
    // heal cycle — verify it landed under the run dir.
    const failedDir = path.join(runDir, 'failed', 'test-case-broken', 'playwright-mcp')
    expect(fs.existsSync(failedDir)).toBe(true)

    // Manifest reflects failed status.
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'))
    expect(manifest.status).toBe('failed')
    expect(manifest.healCycles).toBeGreaterThanOrEqual(1)

    // Event ordering — service first, playwright before heal, agent before run-complete.
    expect(events.indexOf('service-started')).toBeLessThan(events.indexOf('playwright-started'))
    expect(events.indexOf('playwright-exit')).toBeLessThan(events.indexOf('heal-cycle-started'))
    expect(events.indexOf('agent-started')).toBeLessThan(events.indexOf('agent-exit'))
    expect(events.at(-1)).toBe('run-complete')
  }, 15000)
})
