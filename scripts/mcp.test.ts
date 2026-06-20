import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import { createServer } from '../apps/web-server/server'
import type { PtyFactory } from '../apps/web-server/src/features/runs/logic/runtime/pty-spawner'
import {
  bridge,
  doctor,
  ensureMcpServerReachable,
  inferClientKindFromProcessLines,
  inferMcpClientKind,
  isDefaultLocalMcpUrl,
  main,
  REINIT_ID,
  resolveDefaultMcpUrl,
  resolveUiProjectRootForMcpAutostart,
  type BridgeTransport,
} from './mcp'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

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

  it('refreshes the installed agent skill before serving the bridge', async () => {
    const refreshAgents = vi.fn()
    const failingFetch = (async () => { throw new Error('no server') }) as unknown as typeof fetch
    await main(['--url', 'http://127.0.0.1:9/mcp'], {
      refreshAgents,
      stderr: new BufferWritable(),
      fetch: failingFetch,
      autoStartUi: false,
      exit: () => { /* noop */ },
    })
    expect(refreshAgents).toHaveBeenCalledOnce()
  })

  it('does not refresh the agent skill for the diagnostic doctor command', async () => {
    const refreshAgents = vi.fn()
    const failingFetch = (async () => { throw new Error('no server') }) as unknown as typeof fetch
    await main(['doctor', '--url', 'http://127.0.0.1:9/mcp', '--no-autostart'], {
      refreshAgents,
      stdout: new BufferWritable(),
      stderr: new BufferWritable(),
      fetch: failingFetch,
      exit: () => { /* noop */ },
    })
    expect(refreshAgents).not.toHaveBeenCalled()
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

  it('resolves MCP UI autostart from the current workspace before falling back to registry', () => {
    const cwdWorkspace = path.resolve(__dirname, '..', 'templates', 'project')
    const registered = path.resolve(__dirname, '..')

    expect(resolveUiProjectRootForMcpAutostart({
      cwd: cwdWorkspace,
      registry: { version: 1, workspaces: [] },
    })).toBe(cwdWorkspace)

    expect(resolveUiProjectRootForMcpAutostart({
      cwd: '/',
      registry: {
        version: 1,
        workspaces: [
          { name: 'old', path: registered, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          { name: 'workspace', path: cwdWorkspace, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
        ],
      },
    })).toBe(cwdWorkspace)
  })

  it('does not auto-start a UI server from / when no workspace can be resolved', async () => {
    const stderr = new BufferWritable()
    let started = false
    const fetchMock: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    await expect(ensureMcpServerReachable('http://127.0.0.1:7421/mcp', {
      cwd: '/',
      registry: { version: 1, workspaces: [] },
      stderr,
      fetch: fetchMock,
      startUi: async () => { started = true },
      startupPollMs: 1,
      startupTimeoutMs: 5,
    })).resolves.toBe(false)

    expect(started).toBe(false)
    expect(stderr.text()).toContain('Cannot auto-start Canary Lab UI because no workspace could be resolved')
  })

  it('rejects a default local MCP server that is bound to an unusable project root', async () => {
    const stderr = new BufferWritable()
    let started = false
    const fetchMock: typeof fetch = async (url) => {
      if (String(url).endsWith('/mcp/health')) {
        return new Response(JSON.stringify({ ok: true, projectRoot: '/' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new TypeError('unexpected fetch')
    }

    await expect(ensureMcpServerReachable('http://127.0.0.1:7421/mcp', {
      stderr,
      fetch: fetchMock,
      startUi: async () => { started = true },
    })).resolves.toBe(false)

    expect(started).toBe(false)
    expect(stderr.text()).toContain('projectRoot "/"')
    expect(stderr.text()).toContain('Stop that server')
  })

  it('does not auto-start the UI when the URL was explicitly provided (autoStartEligible: false)', async () => {
    const stderr = new BufferWritable()
    let started = false
    const fetchMock: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    await expect(ensureMcpServerReachable('http://127.0.0.1:9/mcp', {
      stderr,
      fetch: fetchMock,
      autoStartEligible: false,
      startUi: async () => { started = true },
      startupPollMs: 1,
      startupTimeoutMs: 5,
    })).resolves.toBe(false)

    expect(started).toBe(false)
    expect(stderr.text()).toContain('Start the UI first: canary-lab ui')
  })

  it('does not auto-start the UI for non-local custom MCP URLs', async () => {
    const stderr = new BufferWritable()
    let started = false
    const fetchMock: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    await expect(ensureMcpServerReachable('http://example.com:9/mcp', {
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

describe('isDefaultLocalMcpUrl', () => {
  it('matches localhost /mcp on any port and rejects non-local or non-/mcp urls', () => {
    expect(isDefaultLocalMcpUrl('http://127.0.0.1:8500/mcp')).toBe(true)
    expect(isDefaultLocalMcpUrl('http://localhost:7421/mcp')).toBe(true)
    expect(isDefaultLocalMcpUrl('http://example.com:7421/mcp')).toBe(false)
    expect(isDefaultLocalMcpUrl('http://127.0.0.1:8500/other')).toBe(false)
    expect(isDefaultLocalMcpUrl('not a url')).toBe(false)
  })
})

describe('resolveDefaultMcpUrl', () => {
  const tmpDirs: string[] = []
  function mkWorkspace(port?: number): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-default-')))
    tmpDirs.push(dir)
    fs.mkdirSync(path.join(dir, 'features'))
    if (port !== undefined) {
      fs.writeFileSync(path.join(dir, 'canary-lab.config.json'), JSON.stringify({ port }))
    }
    return dir
  }
  function cleanup() {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }

  it('builds the url from the active project config port', () => {
    const projectRoot = mkWorkspace(8500)
    const registry = { workspaces: [{ name: 'a', path: projectRoot, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }] }
    try {
      expect(resolveDefaultMcpUrl({ cwd: os.tmpdir(), registry, activeServers: [] })).toBe('http://127.0.0.1:8500/mcp')
    } finally {
      cleanup()
    }
  })

  it('falls back to the default port when the active project pins none', () => {
    const projectRoot = mkWorkspace()
    const registry = { workspaces: [{ name: 'a', path: projectRoot, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }] }
    try {
      expect(resolveDefaultMcpUrl({ cwd: os.tmpdir(), registry, activeServers: [] })).toBe('http://127.0.0.1:7421/mcp')
    } finally {
      cleanup()
    }
  })

  it('falls back to the default port when no project resolves', () => {
    expect(resolveDefaultMcpUrl({ cwd: os.tmpdir(), registry: { workspaces: [] }, activeServers: [] })).toBe('http://127.0.0.1:7421/mcp')
  })

  it('prefers a live active server over the registry/config heuristic', () => {
    expect(resolveDefaultMcpUrl({
      cwd: os.tmpdir(),
      registry: { workspaces: [] },
      activeServers: [{ projectRoot: '/work', port: 7777, pid: 1, updatedAt: '2026-01-01T00:00:00.000Z' }],
    })).toBe('http://127.0.0.1:7777/mcp')
  })
})

class FakeTransport implements BridgeTransport {
  started = false
  closed = false
  sent: JSONRPCMessage[] = []
  protocolVersion?: string
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  constructor(public url: string) {}
  async start(): Promise<void> { this.started = true }
  async send(message: JSONRPCMessage): Promise<void> { this.sent.push(message) }
  async close(): Promise<void> { this.closed = true }
  setProtocolVersion(version: string): void { this.protocolVersion = version }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('bridge reconnect', () => {
  // /mcp/health always answers ok; the bridge can connect and reconnect freely.
  const healthyFetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  it('follows a switched port, re-initializes, and refreshes the client tool list', async () => {
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')
    const stderr = new BufferWritable()
    let target = 'http://127.0.0.1:7420/mcp?profile=full&client_kind=other'

    const ok = await bridge('http://127.0.0.1:7420/mcp', {
      stderr,
      fetch: healthyFetch,
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
      reResolveUrl: () => target,
      reconnectDelayMs: 1,
      reconnectAttempts: 10,
      autoStartUi: false,
    })

    expect(ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].started).toBe(true)

    // The client initializes through the bridge; the bridge caches it.
    stdio.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } as JSONRPCMessage)
    expect(created[0].sent).toContainEqual(expect.objectContaining({ method: 'initialize', id: 1 }))

    // The running UI moves to a new port, then the old connection drops.
    target = 'http://127.0.0.1:7500/mcp?profile=full&client_kind=other'
    created[0].onclose?.()
    await waitFor(() => created.length === 2)

    const next = created[1]
    expect(next.url).toContain('7500')
    expect(next.started).toBe(true)
    // Re-initialize handshake replayed against the new server (sentinel id),
    // followed by the initialized notification.
    expect(next.sent[0]).toMatchObject({ method: 'initialize', id: REINIT_ID, params: { protocolVersion: '2025-06-18' } })
    expect(next.sent[1]).toMatchObject({ method: 'notifications/initialized' })
    // The client is prompted to re-list tools against the new server.
    expect(stdio.sent).toContainEqual(expect.objectContaining({ method: 'notifications/tools/list_changed' }))

    // The sentinel re-initialize reply is swallowed, never forwarded to client.
    const before = stdio.sent.length
    next.onmessage?.({ jsonrpc: '2.0', id: REINIT_ID, result: {} } as JSONRPCMessage)
    expect(stdio.sent).toHaveLength(before)

    // A normal server response still forwards to the client.
    next.onmessage?.({ jsonrpc: '2.0', id: 2, result: { ok: true } } as JSONRPCMessage)
    expect(stdio.sent).toContainEqual(expect.objectContaining({ id: 2 }))
  })

  it('does not reconnect once the client (stdio) side closes', async () => {
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')

    await bridge('http://127.0.0.1:7420/mcp', {
      stderr: new BufferWritable(),
      fetch: healthyFetch,
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
      reResolveUrl: () => 'http://127.0.0.1:7420/mcp?profile=full&client_kind=other',
      reconnectDelayMs: 1,
      reconnectAttempts: 10,
      autoStartUi: false,
    })

    stdio.onclose?.()
    created[0].onclose?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(created).toHaveLength(1)
    expect(created[0].closed).toBe(true)
  })
})
