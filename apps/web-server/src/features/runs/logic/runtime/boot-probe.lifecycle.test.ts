import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, PtyFactory } from './pty-spawner'
import type { ServiceSpec } from './run-orchestrator-types'
import { bootAndProbe } from './boot-probe'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('block fake process groups') })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function processes() {
  const children: Array<{ data: (chunk: string) => void; exit: (code: number, signal?: number) => void; kill: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []
  const factory: PtyFactory = () => {
    let data: (chunk: string) => void = () => {}
    let exit: (event: { exitCode: number; signal?: number }) => void = () => {}
    const kill = vi.fn(); const dispose = vi.fn()
    children.push({ data: (chunk) => data(chunk), exit: (exitCode, signal) => exit({ exitCode, signal }), kill, dispose })
    return {
      pid: 9_100_000 + children.length,
      onData: (fn) => { data = fn; return { dispose } },
      onExit: (fn) => { exit = fn; return { dispose } },
      kill, write: () => {}, resize: () => {},
    } satisfies PtyHandle
  }
  return { children, factory }
}
function spec(name: string): ServiceSpec {
  return { repoName: 'repo', name, safeName: name, command: 'start', cwd: '/tmp',
    healthProbe: { http: { url: `http://${name}.test`, deadlineMs: 5000 } } }
}

describe('standalone boot lifecycle', () => {
  it('rejects a green probe when the process exits while the response is pending', async () => {
    const h = processes()
    const result = await bootAndProbe({ specs: [spec('api')], ptyFactory: h.factory,
      healthCheck: async () => { h.children[0].exit(1, 15); return true },
    })
    expect(result).toMatchObject({ ok: false, failedService: 'api', detail: expect.stringContaining('code 1, signal 15') })
    result.teardown(); result.teardown()
    expect(h.children[0].kill).toHaveBeenCalledTimes(1)
    expect(h.children[0].dispose).toHaveBeenCalledTimes(2)
    h.children[0].exit(9)
    expect(result).toMatchObject({ detail: expect.stringContaining('code 1, signal 15') })
  })

  it('probes services concurrently and rejects an earlier ready service exiting during another probe', async () => {
    const h = processes(); const started: string[] = []
    let finishWeb!: (value: boolean) => void
    const pending = bootAndProbe({ specs: [spec('api'), spec('web')], ptyFactory: h.factory,
      healthCheck: async (url) => {
        started.push(url)
        if (url.includes('api')) return true
        return new Promise<boolean>((resolve) => { finishWeb = resolve })
      },
    })
    expect(started).toEqual(['http://api.test', 'http://web.test'])
    await Promise.resolve()
    h.children[0].exit(0); finishWeb(true)
    const result = await pending
    expect(result).toMatchObject({ ok: false, failedService: 'api' })
    result.teardown()
    expect(h.children.every((child) => child.kill.mock.calls.length === 1)).toBe(true)
  })

  it('detects a compiler failure split across output chunks without waiting for the deadline', async () => {
    const h = processes(); const startedAt = Date.now()
    const pending = bootAndProbe({ specs: [spec('api')], ptyFactory: h.factory, healthCheck: async () => false })
    h.children[0].data('webpack compiled with ')
    h.children[0].data('2 errors\n')
    h.children[0].exit(1)
    const result = await pending
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('Watch compiler reported a failed build') })
    expect(Date.now()).toBe(startedAt)
    result.teardown()
  })

  it('preserves dependency diagnostics when the process exits before readiness', async () => {
    const h = processes()
    const pending = bootAndProbe({ specs: [spec('api')], ptyFactory: h.factory, healthCheck: async () => false })
    h.children[0].data('MongoNetworkError: ECONNREFUSED\n'); h.children[0].exit(1)
    const result = await pending
    expect(result).toMatchObject({ ok: false, kind: 'dependency', detail: expect.stringContaining('MongoNetworkError') })
    result.teardown()
  })

  it.each([new Error('shell unavailable'), 'shell unavailable'])('cleans up earlier processes on partial spawn failure (%s)', async (error) => {
    const h = processes(); let calls = 0
    const result = await bootAndProbe({ specs: [spec('api'), spec('web'), spec('unused')],
      ptyFactory: (options) => { if (++calls === 2) throw error; return h.factory(options) },
    })
    expect(result).toMatchObject({ ok: false, failedService: 'web', detail: expect.stringContaining('shell unavailable') })
    expect(calls).toBe(2)
    expect(h.children[0].kill).toHaveBeenCalledTimes(1)
    result.teardown()
    expect(h.children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('cleans up temporary processes even if an injected probe throws', async () => {
    const h = processes()
    let release!: (value: boolean) => void
    const check = vi.fn(async (url: string) => {
      if (url.includes('api')) throw new Error('probe error')
      return new Promise<boolean>((resolve) => { release = resolve })
    })
    await expect(bootAndProbe({ specs: [spec('api'), spec('web')], ptyFactory: h.factory,
      healthCheck: check,
    })).rejects.toThrow('probe error')
    release(false)
    await vi.runAllTimersAsync()
    expect(check).toHaveBeenCalledTimes(2)
    expect(h.children[0].kill).toHaveBeenCalledTimes(1)
    expect(h.children[0].dispose).toHaveBeenCalledTimes(2)
  })

  it('reports spawn failure even for a service without a readiness probe', async () => {
    const result = await bootAndProbe({ specs: [{ ...spec('worker'), healthProbe: undefined }],
      ptyFactory: () => { throw new Error('missing command') },
    })
    expect(result).toMatchObject({ ok: false, failedService: 'worker', kind: 'unknown' })
    expect(result).not.toHaveProperty('transport')
  })

  it('ignores a late exit notification after successful teardown', async () => {
    const h = processes()
    const result = await bootAndProbe({ specs: [spec('api')], ptyFactory: h.factory, healthCheck: async () => true })
    result.teardown()
    h.children[0].exit(0)
    expect(result.ok).toBe(true)
    expect(h.children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('stops spawning when a factory delivers a compiler failure synchronously', async () => {
    const h = processes(); const factory = vi.fn<PtyFactory>((options) => {
      const pty = h.factory(options)
      return { ...pty, onData: (fn) => { const subscription = pty.onData(fn); fn('webpack compiled with 1 error\n'); return subscription } }
    })
    const result = await bootAndProbe({ specs: [spec('api'), spec('web')], ptyFactory: factory })
    expect(result).toMatchObject({ ok: false, failedService: 'api' })
    expect(factory).toHaveBeenCalledTimes(1)
    result.teardown()
  })
})
