import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureConfig } from '../../../../../shared/launcher/types'
import type { PtyFactory, PtyHandle } from '../pty-spawner'
import { verifyDoubleBoot } from './verify'

// Teardown calls process.kill(-pid). Block the REAL process.kill so a fake pty
// can never signal an actual process group (a fake pid like -1 would otherwise
// kill the whole test session). killTree then falls back to the pty's own kill.
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') }) })
afterEach(() => { vi.restoreAllMocks() })

const fakePty: PtyFactory = (): PtyHandle => ({
  pid: 9_999_999, onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
  write: () => {}, resize: () => {}, kill: () => {},
})

function feature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return { name: 'f', description: 'd', envs: ['local'], featureDir: '/tmp/f', ...over }
}

const verifyLogDir = path.join(os.tmpdir(), 'portify-verify-test')

describe('verifyDoubleBoot', () => {
  it('fails when no port slots are declared', async () => {
    const res = await verifyDoubleBoot(
      feature({ repos: [{ name: 'app', localPath: '~/app', startCommands: ['yarn start'] }] }),
      'local', { app: '/wt/app' },
      { ptyFactory: fakePty, verifyLogDir },
    )
    expect(res.ok).toBe(false)
    expect(res.failureDetail).toContain('No port slots')
    expect(res.instances).toEqual([])
  })

  it('fails when a slot declares no env (cannot inject per-process)', async () => {
    const res = await verifyDoubleBoot(
      feature({ repos: [{ name: 'app', localPath: '~/app', startCommands: [{ command: 'x', ports: [{ name: 'api' }] }] }] }),
      'local', { app: '/wt/app' },
      { ptyFactory: fakePty, verifyLogDir },
    )
    expect(res.ok).toBe(false)
    expect(res.failureDetail).toContain('no `env`')
  })

  it('boots twice and succeeds when both instances pass health', async () => {
    const res = await verifyDoubleBoot(
      feature({ repos: [{ name: 'app', localPath: '~/app', startCommands: [{
        command: 'node server.js', name: 'api', ports: [{ name: 'api', env: 'PORT' }],
        healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 20, deadlineMs: 200 } },
      }] }] }),
      'local', { app: '/wt/app' },
      { ptyFactory: fakePty, healthCheck: async () => true, healthPollIntervalMs: 2, verifyLogDir },
    )
    expect(res.ok).toBe(true)
    expect(res.instances).toHaveLength(2)
    // The two instances were allocated distinct ports for the 'api' slot.
    expect(res.instances[0].ports.api).not.toBe(res.instances[1].ports.api)
  })

  it('reports the failing instance + detail when health never passes', async () => {
    const res = await verifyDoubleBoot(
      feature({ repos: [{ name: 'app', localPath: '~/app', startCommands: [{
        command: 'node server.js', name: 'api', ports: [{ name: 'api', env: 'PORT' }],
        healthCheck: { http: { url: 'http://localhost:${port.api}/health', timeoutMs: 10, deadlineMs: 40 } },
      }] }] }),
      'local', { app: '/wt/app' },
      { ptyFactory: fakePty, healthCheck: async () => false, healthPollIntervalMs: 2, staggerMs: 0, verifyLogDir },
    )
    expect(res.ok).toBe(false)
    expect(res.failureDetail).toContain('api')
    expect(res.instances.some((i) => !i.ok)).toBe(true)
  })
})
