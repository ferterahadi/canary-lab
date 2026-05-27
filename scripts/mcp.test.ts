import { describe, expect, it } from 'vitest'
import path from 'path'
import { Writable } from 'stream'
import { createServer } from '../apps/web-server/server'
import type { PtyFactory } from '../apps/web-server/lib/runtime/pty-spawner'
import {
  bridge,
  doctor,
  ensureMcpServerReachable,
  inferClientKindFromProcessLines,
  inferMcpClientKind,
  main,
} from './mcp'

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

class BufferWritable extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString())
    callback()
  }
  text(): string {
    return this.chunks.join('')
  }
}

describe('canary-lab mcp', () => {
  it('doctor verifies a running UI MCP server and the default full profile', async () => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const stdout = new BufferWritable()
    const stderr = new BufferWritable()
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await expect(doctor(`${address}/mcp`, { stdout, stderr })).resolves.toBe(true)
      expect(stdout.text()).toContain('Canary Lab MCP is reachable')
      expect(stdout.text()).toContain('Profile: full')
      expect(stdout.text()).toContain('start_external_evaluation_export')
      expect(stdout.text()).toContain('execute_verification')
      expect(stderr.text()).toBe('')
      const health = await fetch(`${address}/mcp/health`).then((res) => res.json()) as { projectRoot?: string; profile?: string }
      expect(health.projectRoot).toBe(projectRoot)
      expect(health.profile).toBe('full')
    } finally {
      await app.close()
    }
  })

  it.each([
    ['repair', 'wait_for_heal_task'],
    ['verify', 'execute_verification'],
    ['author', 'create_feature'],
    ['full', 'execute_verification'],
  ] as const)('doctor verifies the %s profile', async (profile, requiredTool) => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const stdout = new BufferWritable()
    const stderr = new BufferWritable()
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await expect(doctor(`${address}/mcp`, { stdout, stderr, profile })).resolves.toBe(true)
      expect(stdout.text()).toContain(`Profile: ${profile}`)
      expect(stdout.text()).toContain(requiredTool)
      expect(stderr.text()).toBe('')
    } finally {
      await app.close()
    }
  })

  it('doctor --no-autostart reports unreachable without trying to start the UI', async () => {
    const stdout = new BufferWritable()
    const stderr = new BufferWritable()
    const exits: number[] = []
    let startUiCalled = false
    const failingFetch = (async () => { throw new Error('no server') }) as unknown as typeof fetch

    await main(['doctor', '--no-autostart'], {
      stdout,
      stderr,
      fetch: failingFetch,
      startUi: () => { startUiCalled = true },
      exit: (code) => { exits.push(code) },
    })

    expect(startUiCalled).toBe(false)
    expect(stderr.text()).toContain('Start the UI first')
    expect(exits).toContain(1)
  })

  it('doctor auto-starts the UI by default when unreachable', async () => {
    const stderr = new BufferWritable()
    let startUiCalled = false
    const failingFetch = (async () => { throw new Error('no server') }) as unknown as typeof fetch

    await main(['doctor'], {
      stdout: new BufferWritable(),
      stderr,
      fetch: failingFetch,
      startUi: () => { startUiCalled = true },
      startupTimeoutMs: 20,
      startupPollMs: 5,
      exit: () => { /* noop */ },
    })

    expect(startUiCalled).toBe(true)
  })

  it('bridge reports a clear error when the UI MCP server is not reachable', async () => {
    const stderr = new BufferWritable()
    await expect(bridge('http://127.0.0.1:9/mcp', { stderr, autoStartUi: false })).resolves.toBe(false)
    expect(stderr.text()).toContain('Start the UI first: canary-lab ui')
  })

  it('auto-starts the UI and waits for health when the default local MCP server is down', async () => {
    const stderr = new BufferWritable()
    let started = false
    let healthChecks = 0
    const fetchMock: typeof fetch = async (url) => {
      healthChecks += 1
      if (String(url).endsWith('/mcp/health') && started) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new TypeError('fetch failed')
    }

    await expect(ensureMcpServerReachable('http://127.0.0.1:7421/mcp', {
      stderr,
      fetch: fetchMock,
      startUi: async () => { started = true },
      startupPollMs: 1,
      startupTimeoutMs: 50,
    })).resolves.toBe(true)

    expect(started).toBe(true)
    expect(healthChecks).toBeGreaterThan(1)
    expect(stderr.text()).toContain('starting `canary-lab ui --no-open`')
  })

  it('does not auto-start the UI for custom MCP URLs', async () => {
    const stderr = new BufferWritable()
    let started = false
    const fetchMock: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    await expect(ensureMcpServerReachable('http://127.0.0.1:9/mcp', {
      stderr,
      fetch: fetchMock,
      startUi: async () => { started = true },
      startupPollMs: 1,
      startupTimeoutMs: 5,
    })).resolves.toBe(false)

    expect(started).toBe(false)
    expect(stderr.text()).toContain('Start the UI first: canary-lab ui')
  })

  it('routes doctor through main and exits 0 on success', async () => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const exits: number[] = []
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await main(['doctor', '--url', `${address}/mcp`], { exit: (code) => { exits.push(code) } })
      expect(exits).toEqual([0])
    } finally {
      await app.close()
    }
  })

  it('routes doctor profile through main', async () => {
    const projectRoot = path.resolve(__dirname, '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    const exits: number[] = []
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      await main(['doctor', '--url', `${address}/mcp`, '--profile', 'verify'], { exit: (code) => { exits.push(code) } })
      expect(exits).toEqual([0])
    } finally {
      await app.close()
    }
  })

  it('rejects invalid profiles', async () => {
    const stderr = new BufferWritable()
    const exits: number[] = []
    await main(['doctor', '--profile', 'nope'], {
      stderr,
      exit: (code) => { exits.push(code) },
    })
    expect(exits).toEqual([1])
    expect(stderr.text()).toContain('Invalid MCP profile: nope')
  })

  it('infers desktop client kind from the launching process tree', () => {
    expect(inferClientKindFromProcessLines([
      '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
      '/sbin/launchd',
    ])).toBe('claude-desktop')
    expect(inferClientKindFromProcessLines([
      '/Applications/Codex.app/Contents/Resources/codex sandbox macos',
      '/sbin/launchd',
    ])).toBe('codex-desktop')
  })

  it('prefers explicit CANARY_LAB_MCP_CLIENT_KIND over process inference', () => {
    expect(inferMcpClientKind({
      CANARY_LAB_MCP_CLIENT_KIND: 'codex-desktop',
    }, 1)).toBe('codex-desktop')
  })
})
