import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { agentJobRoutes } from './agent-jobs'
import { agentJobStore } from '../logic/agent-jobs/store'
import { runAgentProcess } from '../logic/agent-process'
import type { AgentJobManifest } from '../logic/agent-jobs/types'

// Reading and stopping one agent, rather than pausing a whole flight.

let logsDir: string
let app: FastifyInstance

beforeEach(async () => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-agentjob-routes-')))
  app = Fastify()
  await app.register(agentJobRoutes, { logsDir })
})

afterEach(async () => {
  await app.close()
  fs.rmSync(logsDir, { recursive: true, force: true })
})

const job = (over: Partial<AgentJobManifest> = {}): AgentJobManifest => ({
  jobId: 'fl-1:scout',
  flightId: 'fl-1',
  feature: 'checkout',
  stage: 'scout',
  agent: 'claude',
  scope: '/flights/fl-1/scout',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'running',
  ...over,
})

class SignalableChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: vi.fn() }
  signals: NodeJS.Signals[] = []
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM')
    this.emit('close', null, signal ?? 'SIGTERM')
    return true
  }
}

describe('GET /api/agent-jobs', () => {
  it('lists every record, and filters to one flight when asked', async () => {
    agentJobStore(logsDir).save(job())
    agentJobStore(logsDir).save(job({ jobId: 'fl-2:docs', flightId: 'fl-2', stage: 'docs' }))

    const all = await app.inject({ method: 'GET', url: '/api/agent-jobs' })
    expect((all.json() as { jobs: unknown[] }).jobs).toHaveLength(2)

    const scoped = await app.inject({ method: 'GET', url: '/api/agent-jobs?flight=fl-1' })
    expect((scoped.json() as { jobs: Array<{ jobId: string }> }).jobs.map((j) => j.jobId)).toEqual(['fl-1:scout'])
  })
})

describe('POST /api/agent-jobs/:jobId/stop', () => {
  it('stops a live agent and records that the USER asked', async () => {
    const child = new SignalableChild()
    const handle = runAgentProcess({
      command: 'claude', args: [], idleMs: 60_000,
      spawnScope: '/flights/fl-1/scout',
      record: { jobId: 'fl-1:scout', flightId: 'fl-1', feature: 'checkout', stage: 'scout', agent: 'claude' },
      agentJobLogsDir: logsDir,
      spawnImpl: (() => child as unknown as ChildProcess) as never,
      resolveBinary: () => null,
    })

    const res = await app.inject({ method: 'POST', url: '/api/agent-jobs/fl-1:scout/stop' })
    await handle.done.catch(() => {})

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ stopped: true, jobId: 'fl-1:scout' })
    expect(child.signals).toContain('SIGTERM')
    // `stoppedBy: user` is the difference between this and a flight-driven
    // teardown — same exit, different story for whoever reads the row.
    expect(agentJobStore(logsDir).get('fl-1:scout')).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
  })

  it('is an idempotent no-op on an agent that already finished', async () => {
    agentJobStore(logsDir).save(job({ status: 'done', endedAt: '2026-01-01T00:01:00.000Z' }))
    const res = await app.inject({ method: 'POST', url: '/api/agent-jobs/fl-1:scout/stop' })
    // Never a 409: a stop is best-effort cleanup, and "already done" is a success
    // for it.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ stopped: false, status: 'done' })
  })

  it('reports honestly when a running record has no scope to reach it by', async () => {
    // A record from before scoped stopping. Claiming success here would be a lie.
    agentJobStore(logsDir).save(job({ scope: undefined }))
    const res = await app.inject({ method: 'POST', url: '/api/agent-jobs/fl-1:scout/stop' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ stopped: false, status: 'running' })
  })

  it('404s an unknown job', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent-jobs/nope/stop' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'agent job not found' })
  })
})
