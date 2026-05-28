import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileRunStateSink } from './run-state-sink'
import { readManifest, readRunsIndex, type RunManifest } from './manifest'
import { buildRunPaths, runDirFor } from './run-paths'

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rss-')))
})

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1',
    feature: 'checkout',
    startedAt: '2026-05-08T00:00:00.000Z',
    status: 'running',
    healCycles: 0,
    services: [
      {
        name: 'API',
        safeName: 'api',
        command: 'npm run api',
        cwd: '/repo/api',
        logPath: '/logs/api.log',
        status: 'starting',
      },
    ],
    ...overrides,
  }
}

describe('FileRunStateSink', () => {
  it('bootstraps the manifest and runs index without a current run pointer', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())

    expect(readManifest(sink.manifestPath('run-1'))?.feature).toBe('checkout')
    expect(readRunsIndex(logsDir)).toEqual([
      {
        runId: 'run-1',
        feature: 'checkout',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'running',
      },
    ])
    expect(fs.existsSync(path.join(logsDir, 'current'))).toBe(false)
  })

  it('updates status, heal cycles, service status, heartbeat, and manifest patches', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())

    sink.setStatus('run-1', 'healing', 2)
    sink.setServiceStatus('run-1', 'api', 'ready')
    sink.recordHeartbeat('run-1')
    sink.patchManifest('run-1', {
      healMode: 'manual',
      signalPaths: { rerun: '/logs/.rerun', restart: '/logs/.restart' },
    })

    const stored = readManifest(sink.manifestPath('run-1'))!
    expect(stored.status).toBe('healing')
    expect(stored.healCycles).toBe(2)
    expect(stored.services[0].status).toBe('ready')
    expect(stored.heartbeatAt).toEqual(expect.any(String))
    expect(stored.healMode).toBe('manual')
    expect(readRunsIndex(logsDir)[0].status).toBe('healing')
  })

  it('records lifecycle events in JSONL and mirrors the latest snapshot into the manifest', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())

    sink.recordLifecycleEvent('run-1', {
      phase: 'waiting-for-signal',
      headline: 'Waiting for heal signal',
      detail: 'The runner is waiting for .restart.',
      updatedAt: '2026-05-08T00:00:05.000Z',
      lastSignal: { kind: 'restart', status: 'accepted' },
    })

    const lifecyclePath = buildRunPaths(runDirFor(logsDir, 'run-1')).lifecycleEventsPath
    const lines = fs.readFileSync(lifecyclePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ phase: 'waiting-for-signal', headline: 'Waiting for heal signal' })
    expect(readManifest(sink.manifestPath('run-1'))?.lifecycle).toMatchObject({
      phase: 'waiting-for-signal',
      headline: 'Waiting for heal signal',
      lastSignal: { kind: 'restart', status: 'accepted' },
    })
  })

  it('stamps a fresh updatedAt when recordLifecycleEvent omits one', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())
    const before = new Date().toISOString()
    sink.recordLifecycleEvent('run-1', {
      phase: 'waiting-for-signal',
      headline: 'auto-stamped',
      detail: 'no updatedAt provided',
      updatedAt: '',
    })
    const lifecyclePath = buildRunPaths(runDirFor(logsDir, 'run-1')).lifecycleEventsPath
    const event = JSON.parse(fs.readFileSync(lifecyclePath, 'utf-8').trim())
    expect(event.updatedAt).not.toBe('')
    expect(event.updatedAt >= before).toBe(true)
  })

  it('finalizes services, clears running summary state, and mirrors endedAt into the index', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())
    const summaryPath = path.join(runDirFor(logsDir, 'run-1'), 'e2e-summary.json')
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({ complete: false, running: { name: 'test-case-checkout' }, failed: [] }),
    )

    sink.finalize('run-1', 'passed', '2026-05-08T00:01:00.000Z', 1)

    const stored = readManifest(sink.manifestPath('run-1'))!
    expect(stored.status).toBe('passed')
    expect(stored.endedAt).toBe('2026-05-08T00:01:00.000Z')
    expect(stored.healCycles).toBe(1)
    expect(stored.services[0].status).toBe('stopped')
    expect(JSON.parse(fs.readFileSync(summaryPath, 'utf-8')).running).toBeUndefined()
    expect(readRunsIndex(logsDir)[0].endedAt).toBe('2026-05-08T00:01:00.000Z')
  })

  it('leaves malformed summaries untouched during finalize', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())
    const summaryPath = path.join(runDirFor(logsDir, 'run-1'), 'e2e-summary.json')
    fs.writeFileSync(summaryPath, '{bad json')

    sink.finalize('run-1', 'failed', '2026-05-08T00:02:00.000Z', 0)

    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe('{bad json')
    expect(readManifest(sink.manifestPath('run-1'))?.status).toBe('failed')
  })

  it('leaves non-object JSON summaries untouched during finalize', () => {
    const sink = new FileRunStateSink(logsDir)
    sink.bootstrap(manifest())
    const summaryPath = path.join(runDirFor(logsDir, 'run-1'), 'e2e-summary.json')
    fs.writeFileSync(summaryPath, '42')

    sink.finalize('run-1', 'failed', '2026-05-08T00:03:00.000Z', 0)

    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe('42')
  })
})
