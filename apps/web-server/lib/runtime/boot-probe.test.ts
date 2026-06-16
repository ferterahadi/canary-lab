import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { ServiceSpec } from './orchestrator'
import { bootAndProbe, fileTee, diagnoseBootOutput } from './boot-probe'

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

// A pty whose stream emits the given chunk(s) once subscribed — for asserting
// that bootAndProbe captures process output and surfaces it on a failed boot.
function emittingFactory(...chunks: string[]): PtyFactory {
  return (): PtyHandle => {
    const data = new EventEmitter()
    queueMicrotask(() => { for (const c of chunks) data.emit('data', c) })
    return {
      pid: 7_100_001,
      onData: (cb) => { data.on('data', cb); return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: () => {}, resize: () => {}, kill: () => {},
    }
  }
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

  it('captures the crash reason and classifies a dependency failure on timeout', async () => {
    // The gateway maps its routes then dies in bootstrap because a downstream
    // DB is unreachable — so it never binds and the readiness probe times out.
    const factory = emittingFactory(
      "[0m[0][0m Mapped {/healthz, GET} route\n" +
        "[0m[0][0m Init-Failed {\n  app: 'gateway',\n  reason: \"Can't reach database server at `34.87.54.225:3306`\"\n}\n",
    )
    const res = await bootAndProbe({
      specs: [httpSpec('gateway', 'http://localhost:5000/healthz')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('dependency')
      // The probe symptom is preserved AND the real cause is surfaced.
      expect(res.detail).toContain('http://localhost:5000/healthz')
      expect(res.detail).toContain("Can't reach database server")
    }
    res.teardown()
  })

  it('appends a Full boot log pointer to the failure detail when fullLogPathFor is set', async () => {
    const factory = emittingFactory('booting\nwarming caches\nstill starting up\n')
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
      fullLogPathFor: (safeName) => `/runs/X/verify/a-${safeName}.log`,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // The 12-line evidence slice is preserved AND the agent is pointed at the full log.
      expect(res.detail).toContain('warming caches')
      expect(res.detail).toContain('Full boot log: /runs/X/verify/a-api.log')
    }
    res.teardown()
  })

  it('points the failure detail at a cleaned (ANSI-stripped, deduped) full log when the raw log exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-clean-'))
    const raw =
      '\x1b[32mstarting\x1b[0m\n' +
      'waiting for db\n'.repeat(5) +
      'still down\n'
    const factory = emittingFactory(raw)
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
      onOutput: fileTee(dir, 'a'),
      fullLogPathFor: (safeName) => path.join(dir, `a-${safeName}.log`),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const cleanPath = path.join(dir, 'a-api.clean.log')
      expect(res.detail).toContain(`Full boot log: ${cleanPath}`)
      const clean = fs.readFileSync(cleanPath, 'utf-8')
      expect(clean).not.toMatch(/\x1b\[/)             // ANSI stripped
      expect(clean).toContain('waiting for db  (×5)') // consecutive lines deduped
      expect(clean).toContain('starting')
    }
    res.teardown()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('omits the Full boot log pointer when fullLogPathFor is not provided', async () => {
    const factory = emittingFactory('booting\nstill starting up\n')
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).not.toContain('Full boot log:')
    res.teardown()
  })

  it('classifies an EADDRINUSE crash as a port conflict', async () => {
    const factory = emittingFactory('Error: listen EADDRINUSE: address already in use 0.0.0.0:5000\n')
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('port-conflict')
      expect(res.detail).toContain('EADDRINUSE')
    }
    res.teardown()
  })

  it('falls back to a log tail (kind unknown) when no known crash marker is present', async () => {
    const factory = emittingFactory('booting\nwarming caches\nstill starting up\n')
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('unknown')
      expect(res.detail).toContain('warming caches')
    }
    res.teardown()
  })

  it('diagnoseBootOutput returns no evidence and unknown kind for empty output', () => {
    expect(diagnoseBootOutput('')).toEqual({ kind: 'unknown' })
  })

  it('truncates the diagnostic buffer when output exceeds the cap', async () => {
    // Send slightly more than DIAG_BUFFER_CAP (16 384 bytes) so the slice(-cap) arm is taken.
    const bigChunk = 'x'.repeat(17_000)
    const factory = emittingFactory(bigChunk)
    const res = await bootAndProbe({
      specs: [httpSpec('api', 'http://localhost:5000/')],
      ptyFactory: factory,
      healthCheck: async () => false,
      healthPollIntervalMs: 5,
    })
    expect(res.ok).toBe(false)
    res.teardown()
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
