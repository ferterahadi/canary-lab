import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'os'
import http from 'http'
import https from 'https'
import { EventEmitter } from 'events'
import net from 'net'
import {
  coerceProbe,
  enabledForEnv,
  resolvePath,
  normalizeStartCommand,
  isHealthy,
  isTcpListening,
  resolveHealthProbe,
  validateHealthCheck,
} from './startup'
import type { HealthCheck } from '../../../../../shared/launcher/types'

function mockHttpGet(
  mod: typeof http | typeof https,
  behavior: 'ok' | 'server-error' | 'timeout' | 'error',
  statusCode = 200,
) {
  return vi.spyOn(mod, 'get').mockImplementation(((...args: any[]) => {
    const cb = args[args.length - 1] as (res: any) => void
    const req: any = new EventEmitter()
    req.destroy = vi.fn()
    if (behavior === 'timeout') {
      setImmediate(() => req.emit('timeout'))
    } else if (behavior === 'error') {
      setImmediate(() => req.emit('error', new Error('boom')))
    } else {
      const res: any = new EventEmitter()
      res.resume = vi.fn()
      res.statusCode = behavior === 'server-error' ? 500 : statusCode
      setImmediate(() => cb(res))
    }
    return req
  }) as any)
}

describe('resolvePath', () => {
  it('expands leading ~/ to the home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/test')
    expect(resolvePath('~/projects/foo')).toBe('/Users/test/projects/foo')
  })

  it('leaves absolute paths untouched', () => {
    expect(resolvePath('/abs/path')).toBe('/abs/path')
  })

  it('leaves a bare "~" or "~foo" (no slash) untouched', () => {
    expect(resolvePath('~')).toBe('~')
    expect(resolvePath('~foo')).toBe('~foo')
  })

  it('leaves relative paths untouched', () => {
    expect(resolvePath('relative/path')).toBe('relative/path')
  })
})

describe('normalizeStartCommand', () => {
  it('wraps a string into {command, name: fallback}', () => {
    expect(normalizeStartCommand('npm run dev', 'svc')).toEqual({
      command: 'npm run dev',
      name: 'svc',
    })
  })

  it('passes through object with explicit name', () => {
    expect(
      normalizeStartCommand({ command: 'x', name: 'real' }, 'fallback'),
    ).toEqual({ command: 'x', name: 'real' })
  })

  it('fills in name when object has none', () => {
    expect(normalizeStartCommand({ command: 'x' } as any, 'fallback')).toEqual({
      command: 'x',
      name: 'fallback',
    })
  })

  it('preserves extra fields on the object form', () => {
    const result = normalizeStartCommand(
      { command: 'x', healthCheck: { url: 'http://a', timeoutMs: 10 } } as any,
      'svc',
    )
    expect(result).toEqual({
      command: 'x',
      name: 'svc',
      healthCheck: { url: 'http://a', timeoutMs: 10 },
    })
  })
})

describe('enabledForEnv', () => {
  it('keeps legacy callers and commands without env filters enabled', () => {
    expect(enabledForEnv(['local'], undefined)).toBe(true)
    expect(enabledForEnv(undefined, 'beta')).toBe(true)
  })

  it('checks env whitelists when an env is selected', () => {
    expect(enabledForEnv(['local', 'beta'], 'beta')).toBe(true)
    expect(enabledForEnv(['local'], 'beta')).toBe(false)
  })
})

describe('isHealthy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses http.get for http:// URLs and resolves true for 2xx', async () => {
    const spy = mockHttpGet(http, 'ok', 200)
    await expect(isHealthy('http://x/ping')).resolves.toBe(true)
    expect(spy).toHaveBeenCalledWith(
      'http://x/ping',
      expect.objectContaining({ timeout: 1500 }),
      expect.any(Function),
    )
  })

  it('uses https.get for https:// URLs', async () => {
    const spy = mockHttpGet(https, 'ok', 204)
    await expect(isHealthy('https://x/ping')).resolves.toBe(true)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('respects timeoutMs override', async () => {
    const spy = mockHttpGet(http, 'ok', 200)
    await isHealthy('http://x/', 250)
    expect(spy.mock.calls[0][1]).toMatchObject({ timeout: 250 })
  })

  it('resolves true for any status < 500 (404 counts as "reachable")', async () => {
    mockHttpGet(http, 'ok', 404)
    await expect(isHealthy('http://x/')).resolves.toBe(true)
  })

  it('resolves false for 5xx', async () => {
    mockHttpGet(http, 'server-error')
    await expect(isHealthy('http://x/')).resolves.toBe(false)
  })

  it('treats responses without a status code as reachable', async () => {
    vi.spyOn(http, 'get').mockImplementation(((...args: any[]) => {
      const cb = args[args.length - 1] as (res: any) => void
      const req: any = new EventEmitter()
      req.destroy = vi.fn()
      const res: any = new EventEmitter()
      res.resume = vi.fn()
      setImmediate(() => cb(res))
      return req
    }) as any)
    await expect(isHealthy('http://x/')).resolves.toBe(true)
  })

  it('resolves false when the request times out (and destroys the request)', async () => {
    let destroyed = false
    vi.spyOn(http, 'get').mockImplementation(((...args: any[]) => {
      const req: any = new EventEmitter()
      req.destroy = () => {
        destroyed = true
      }
      setImmediate(() => req.emit('timeout'))
      return req
    }) as any)
    await expect(isHealthy('http://x/')).resolves.toBe(false)
    expect(destroyed).toBe(true)
  })

  it('resolves false on request error', async () => {
    mockHttpGet(http, 'error')
    await expect(isHealthy('http://x/')).resolves.toBe(false)
  })
})


describe('resolveHealthProbe', () => {
  it('returns null when check is undefined', () => {
    expect(resolveHealthProbe(undefined, 'local')).toBeNull()
  })

  it('returns null for an empty config (defensive)', () => {
    expect(resolveHealthProbe({} as HealthCheck, 'local')).toBeNull()
  })

  it('returns the tagged http probe as-is, regardless of env', () => {
    const probe: HealthCheck = { http: { url: 'http://localhost:3000', timeoutMs: 1500 } }
    expect(resolveHealthProbe(probe, 'local')).toEqual(probe)
    expect(resolveHealthProbe(probe, 'beta')).toEqual(probe)
    expect(resolveHealthProbe(probe, undefined)).toEqual(probe)
  })

  it('returns the tagged tcp probe as-is', () => {
    const probe: HealthCheck = { tcp: { port: 3000 } }
    expect(resolveHealthProbe(probe, 'local')).toEqual(probe)
  })

  it('coerces the legacy bare-url shape to a tagged http probe (back-compat)', () => {
    const legacy: HealthCheck = { url: 'http://localhost:4000', timeoutMs: 2500 }
    expect(resolveHealthProbe(legacy, 'local')).toEqual({
      http: { url: 'http://localhost:4000', timeoutMs: 2500 },
    })
  })

  it('picks the entry matching env from a per-env map (mixed shapes ok)', () => {
    const m: HealthCheck = {
      local: { tcp: { port: 3000 } },
      beta:  { http: { url: 'http://beta.example', timeoutMs: 2000 } },
    }
    expect(resolveHealthProbe(m, 'local')).toEqual({ tcp: { port: 3000 } })
    expect(resolveHealthProbe(m, 'beta')).toEqual({ http: { url: 'http://beta.example', timeoutMs: 2000 } })
  })

  it('coerces a legacy entry inside a per-env map', () => {
    const m: HealthCheck = {
      local: { url: 'http://localhost', timeoutMs: 1000 },
      beta:  { http: { url: 'http://beta' } },
    }
    expect(resolveHealthProbe(m, 'local')).toEqual({
      http: { url: 'http://localhost', timeoutMs: 1000 },
    })
  })

  it('falls back to the default key when env is unknown', () => {
    const m: HealthCheck = {
      default: { http: { url: 'http://fallback' } },
      local: { tcp: { port: 3000 } },
    }
    expect(resolveHealthProbe(m, 'staging')).toEqual({ http: { url: 'http://fallback' } })
  })

  it('returns null when neither env nor default match', () => {
    const m: HealthCheck = { local: { http: { url: 'http://l' } } }
    expect(resolveHealthProbe(m, 'beta')).toBeNull()
  })

  it('rejects malformed probe shapes during coercion', () => {
    expect(() => coerceProbe({ timeoutMs: 100 } as never)).toThrow(/declare one transport/)
  })
})

describe('validateHealthCheck', () => {
  const ctx = { feature: 'feat', command: 'cmd' }

  it('allows undefined checks', () => {
    expect(() => validateHealthCheck(undefined, ctx)).not.toThrow()
  })

  it('rejects non-object checks', () => {
    expect(() => validateHealthCheck('http://x' as never, ctx)).toThrow(/must be an object/)
  })

  it('rejects invalid env-map entries', () => {
    expect(() => validateHealthCheck({ local: null } as never, ctx)).toThrow(/env entry/)
  })

  it('accepts a tagged http probe', () => {
    expect(() => validateHealthCheck({ http: { url: 'http://x' } }, ctx)).not.toThrow()
  })

  it('accepts a tagged tcp probe', () => {
    expect(() => validateHealthCheck({ tcp: { port: 3000 } }, ctx)).not.toThrow()
  })

  it('accepts the legacy bare-url shape (back-compat)', () => {
    expect(() => validateHealthCheck({ url: 'http://x' }, ctx)).not.toThrow()
  })

  it('accepts a per-env map with mixed shapes', () => {
    expect(() => validateHealthCheck({
      local: { tcp: { port: 3000 } },
      beta:  { http: { url: 'http://b' } },
      legacy: { url: 'http://l' },
    }, ctx)).not.toThrow()
  })

  it('rejects a probe with both http and tcp keys', () => {
    expect(() => validateHealthCheck({
      http: { url: 'http://x' },
      tcp:  { port: 3000 },
    } as unknown as HealthCheck, ctx)).toThrow(/exactly one transport/)
  })

  it('rejects an empty config object', () => {
    expect(() => validateHealthCheck({} as HealthCheck, ctx)).toThrow(/empty/)
  })

  it('rejects http with missing url', () => {
    expect(() => validateHealthCheck({ http: {} as never }, ctx)).toThrow(/http\.url/)
  })

  it('rejects tcp with missing port', () => {
    expect(() => validateHealthCheck({ tcp: {} as never }, ctx)).toThrow(/tcp\.port/)
  })

  it('rejects tcp with non-positive port', () => {
    expect(() => validateHealthCheck({ tcp: { port: 0 } }, ctx)).toThrow(/tcp\.port/)
  })

  it('rejects legacy probes with missing url', () => {
    expect(() => validateHealthCheck({ url: '' }, ctx)).toThrow(/legacy healthCheck\.url/)
  })

  it('error message names the feature, command, and env when applicable', () => {
    let caught: Error | null = null
    try {
      validateHealthCheck({ local: { http: { url: '' } } }, { feature: 'F', command: 'C' })
    } catch (e) { caught = e as Error }
    expect(caught?.message).toMatch(/Feature "F"/)
    expect(caught?.message).toMatch(/command "C"/)
    expect(caught?.message).toMatch(/env "local"/)
  })
})

describe('isTcpListening', () => {
  it('returns true for a port currently in LISTEN', async () => {
    const server = net.createServer().listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      await expect(isTcpListening(port, '127.0.0.1', 500)).resolves.toBe(true)
    } finally {
      server.close()
    }
  })

  it('returns false for a port nothing is listening on', async () => {
    // Port 1 is virtually never bound on a normal machine; if it is, this
    // test will be flaky — pick another reserved-ish port.
    await expect(isTcpListening(1, '127.0.0.1', 200)).resolves.toBe(false)
  })

  it('ignores late socket events after a TCP probe has settled', async () => {
    const socket: any = new EventEmitter()
    socket.destroy = vi.fn()
    const createConnection = vi.spyOn(net, 'createConnection').mockReturnValue(socket)
    try {
      const result = isTcpListening(1234, '127.0.0.1', 200)
      socket.emit('connect')
      socket.emit('error', new Error('late'))

      await expect(result).resolves.toBe(true)
      expect(createConnection).toHaveBeenCalledWith({ port: 1234, host: '127.0.0.1' })
    } finally {
      createConnection.mockRestore()
    }
  })
})
