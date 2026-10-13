import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from './server'
import { ORPHANED_RUN_SWEEP_MS } from './features/runs/logic/run-store'
import { readRunsIndex, writeManifest, writeRunsIndex } from './features/runs/logic/runtime/manifest'
import type { RunHeartbeatOwner } from '../../../shared/run-manifest'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'

// A run outlives its server when that server stops mid-run. These drive the real
// server: the next boot must settle the run truthfully, and while it runs, a run
// a live peer drove must settle once that peer dies — reaching an already-open
// Runs socket without a refresh.

const tempDir = trackTempDirs('orphaned-runs-server-')

afterEach(() => { vi.restoreAllMocks() })

function seedHealingRun(logsDir: string, runId: string, owner: RunHeartbeatOwner): void {
  const runDir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  const startedAt = '2026-10-09T05:59:00.000Z'
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId, feature: 'storefront-journey', startedAt, status: 'healing', healCycles: 1, healMode: 'manual',
    services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    heartbeatAt: new Date().toISOString(), heartbeatOwner: owner,
  })
  writeRunsIndex(logsDir, [...readRunsIndex(logsDir), { runId, feature: 'storefront-journey', startedAt, status: 'healing' }])
}

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid
}

it('settles at boot a healing run whose server exited inside the staleness window, and spares a live peer\'s', async () => {
  const projectRoot = tempDir()
  const logsDir = path.join(projectRoot, 'logs')
  seedHealingRun(logsDir, '2026-10-09T0559-ulr5', { pid: exitedPid(), instanceId: 'exited' })
  seedHealingRun(logsDir, 'peer-run', { pid: process.ppid, instanceId: 'live-peer' })

  const { app } = await createServer({ projectRoot })
  try {
    const orphan = (await app.inject('/api/runs/2026-10-09T0559-ulr5')).json()
    expect(orphan.manifest).toMatchObject({ status: 'aborted', lifecycle: { phase: 'aborted', abortReason: { reason: 'server-exited' } } })
    expect(orphan.manifest.services[0].status).toBe('stopped')
    expect((await app.inject('/api/runs/peer-run')).json().manifest.status).toBe('healing')
  } finally {
    await app.close()
  }
}, 20_000)

it('settles a peer\'s run once the peer dies, live to an open Runs socket, and survives a failing sweep', async () => {
  const projectRoot = tempDir()
  const logsDir = path.join(projectRoot, 'logs')
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  seedHealingRun(logsDir, 'peer-run', { pid: peer.pid!, instanceId: 'live-peer' })
  const intervals = vi.spyOn(globalThis, 'setInterval')

  const { app, runStore } = await createServer({ projectRoot })
  await app.ready()
  const sweep = intervals.mock.calls.find(([, ms]) => ms === ORPHANED_RUN_SWEEP_MS)![0] as () => void
  const frames: Array<{ type: string; runId?: string; detail?: { manifest: { status: string } } }> = []
  const socket = await app.injectWS('/ws/runs', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  try {
    sweep()
    expect((await app.inject('/api/runs/peer-run')).json().manifest.status).toBe('healing')

    await new Promise((resolve) => { peer.once('exit', resolve); peer.kill('SIGKILL') })
    sweep()

    await expect.poll(() => frames.some((f) => f.type === 'update' && f.runId === 'peer-run' && f.detail?.manifest.status === 'aborted'), { timeout: 5000 }).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/api/runs/peer-run/cancel-heal' })).statusCode).toBe(404)

    vi.spyOn(runStore, 'settleOrphanedRuns').mockImplementation(() => { throw new Error('index unreadable') })
    expect(() => sweep()).not.toThrow()
  } finally {
    peer.kill('SIGKILL')
    socket.terminate()
    await app.close()
  }
}, 20_000)
