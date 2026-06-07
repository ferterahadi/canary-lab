import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { ServiceSpec } from './orchestrator'
import { bootAndProbe, fileTee } from './boot-probe'

// Teardown calls process.kill(-pid). Block the REAL process.kill so a fake pty
// can never signal a real process group; killTree falls back to pty.kill, which
// our fakes record. (A negative fake pid would otherwise kill real processes.)
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') }) })
afterEach(() => { vi.restoreAllMocks() })

function fakeFactory(): { factory: PtyFactory; spawned: PtySpawnOptions[]; killed: number[] } {
  const spawned: PtySpawnOptions[] = []
  const killed: number[] = []
  const factory: PtyFactory = (options): PtyHandle => {
    spawned.push(options)
    const pid = 200 + spawned.length
    return {
      pid,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => { killed.push(pid) },
    }
  }
  return { factory, spawned, killed }
}

function httpSpec(name: string, url: string): ServiceSpec {
  return {
    repoName: 'r', name, safeName: name, command: `run ${name}`, cwd: '/tmp',
    healthProbe: { http: { url, timeoutMs: 50, deadlineMs: 300 } },
    env: { PORT: '5000' },
  }
}

describe('bootAndProbe', () => {
  it('resolves ok when every service becomes healthy', async () => {
    const { factory, spawned } = fakeFactory()
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => true,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(true)
    expect(spawned).toHaveLength(1)
    res.teardown()
  })

  it('fails with the offending service when a probe never passes', async () => {
    const { factory } = fakeFactory()
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/health')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.failedService).toBe('api')
      expect(res.detail).toContain('http://localhost:5000/health')
    }
    res.teardown()
  })

  function tcpSpec(name: string, port: number): ServiceSpec {
    return {
      repoName: 'r', name, safeName: name, command: `run ${name}`, cwd: '/tmp',
      healthProbe: { tcp: { port, host: '127.0.0.1', timeoutMs: 20, deadlineMs: 40 } },
    }
  }

  it('uses a TCP probe and reports the closed port on timeout (default health poller)', async () => {
    const { factory } = fakeFactory()
    // No healthCheck passed → exercises the `?? isHealthy` default; TCP path uses
    // the real isTcpListening against a closed port → fails fast.
    const res = await bootAndProbe({
      specs: [tcpSpec('db', 9)], // port 9 (discard) is not listening locally
      ptyFactory: factory,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.transport).toBe('tcp')
      expect(res.detail).toContain('port=9')
    }
    res.teardown()
  })

  it('applies the fallback deadline and default host when the tcp probe omits them', async () => {
    const { factory } = fakeFactory()
    const spec: ServiceSpec = {
      repoName: 'r', name: 'db', safeName: 'db', command: 'run db', cwd: '/tmp',
      healthProbe: { tcp: { port: 9 } }, // no host, no deadlineMs
    }
    const res = await bootAndProbe({ specs: [spec], ptyFactory: factory, healthPollIntervalMs: 5, healthDeadlineMs: 30 })
    expect(res.ok).toBe(false)
    res.teardown()
  })

  it('skips services with no readiness probe', async () => {
    const { factory } = fakeFactory()
    const noProbe: ServiceSpec = { repoName: 'r', name: 'bg', safeName: 'bg', command: 'run bg', cwd: '/tmp' }
    const res = await bootAndProbe({ specs: [noProbe], ptyFactory: factory, healthCheck: async () => false })
    expect(res.ok).toBe(true) // nothing to wait on
    res.teardown()
  })

  it('tees service output to a per-instance log file via fileTee', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-tee-'))
    // A factory whose pty emits one data chunk on subscribe.
    const factory: PtyFactory = (): PtyHandle => {
      const data = new EventEmitter()
      queueMicrotask(() => data.emit('data', 'hello-log'))
      return {
        pid: 7_000_001,
        onData: (cb) => { data.on('data', cb); return { dispose: () => {} } },
        onExit: () => ({ dispose: () => {} }),
        write: () => {}, resize: () => {}, kill: () => {},
      }
    }
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => true,
      healthPollIntervalMs: 5,
      onOutput: fileTee(dir, 'a'),
    })
    await new Promise((r) => setTimeout(r, 10))
    res.teardown()
    expect(fs.readFileSync(path.join(dir, 'a-api.log'), 'utf-8')).toContain('hello-log')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('teardown kills every spawned process group', async () => {
    const { factory, killed } = fakeFactory()
    const res = await bootAndProbe({
      specs: [httpSpec('a', 'http://localhost:5001/'), httpSpec('b', 'http://localhost:5002/')],
      ptyFactory: factory,
      healthCheck: async () => true,
      healthPollIntervalMs: 5,
    })
    res.teardown()
    res.teardown() // idempotent
    // The suite-wide process.kill(-pid) mock throws → falls back to pty.kill.
    expect(killed).toEqual([201, 202])
  })
})
