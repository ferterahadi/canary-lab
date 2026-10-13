import { beforeEach, expect, it, vi } from 'vitest'
import { Writable } from 'stream'
import os from 'os'
import { doctor } from './mcp'
import { verifySavedMcpRegistration } from './mcp-verify'

const fixture = vi.hoisted(() => ({
  callTool: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  transportClose: vi.fn(),
  listTools: vi.fn(),
}))
vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: class {
    callTool = fixture.callTool
    connect = fixture.connect
    close = fixture.close
    listTools = fixture.listTools
  },
  StreamableHTTPClientTransport: class {},
}))
vi.mock('@modelcontextprotocol/client/stdio', async (importOriginal) => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>(),
  StdioClientTransport: class { close = fixture.transportClose },
}))

beforeEach(() => {
  vi.resetAllMocks()
  fixture.connect.mockResolvedValue(undefined)
  fixture.close.mockResolvedValue(undefined)
  fixture.transportClose.mockResolvedValue(undefined)
  fixture.listTools.mockResolvedValue({ tools: [{ name: 'exec' }] })
})

function sink() {
  let text = ''
  return { stream: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } }), text: () => text }
}

it.each([
  [{ content: [{ type: 'text', text: '{"matches":[{"command":"get_feature_coverage"}]}' }, { type: 'text', text: 'ignored' }] }, true, ''],
  [{}, false, 'exec search_tools returned no text result'],
  [{ content: [] }, false, 'exec search_tools returned no text result'],
  [{ content: [{ type: 'image' }, { type: 'text', text: '{"matches":[]}' }] }, false, 'exec search_tools returned no text result'],
  [{ content: [{ type: 'text', text: '{}' }] }, false, 'exec search_tools could not discover get_feature_coverage'],
  [{ content: [{ type: 'text', text: '{"matches":[' }, { type: 'text', text: '{"command":"get_feature_coverage"}]}' }] }, false, 'JSON'],
] as const)('doctor retains first-text decoding and diagnostics for %j', async (result, ok, error) => {
  fixture.callTool.mockResolvedValue(result)
  const stdout = sink()
  const stderr = sink()
  expect(await doctor('http://127.0.0.1:12345/mcp', {
    stdout: stdout.stream, stderr: stderr.stream, autoStartUi: false,
    fetch: vi.fn(async () => new Response('{"toolCount":1}')),
  })).toBe(ok)
  expect(stderr.text()).toContain(error)
  if (ok) expect(stdout.text()).toContain('Command probe: get_feature_coverage discovered')
  expect(fixture.callTool).toHaveBeenCalledExactlyOnceWith({ name: 'exec', arguments: { command: 'search_tools', arguments: { query: 'get_feature_coverage' } } })
  expect(fixture.close).toHaveBeenCalledOnce()
})

it.each([
  [{ content: [{ type: 'text', text: '{"matches":[' }, { type: 'image' }, { type: 'text', text: '{"command":"get_feature_coverage"}]}' }] }, 'verified', 'compact MCP connected'],
  [{}, 'broken', 'JSON'],
  [{ content: [{ type: 'image' }] }, 'broken', 'JSON'],
  [{ content: [{ type: 'text', text: '{}' }] }, 'broken', 'exec command discovery failed'],
] as const)('registration retains joined-text decoding for %j', async (response, status, message) => {
  fixture.callTool.mockResolvedValue(response)
  const result = await verifySavedMcpRegistration({ command: 'fixture-node', args: ['fixture-cli', 'mcp'] }, {
    workspace: os.tmpdir(), timeoutMs: 1234,
    run: () => ({ exitCode: 0, output: 'Canary Lab MCP is reachable at http://127.0.0.1:12345/mcp' }),
    fetch: vi.fn(async () => new Response(JSON.stringify({ projectRoot: os.tmpdir() }))),
  })
  expect(result.status).toBe(status)
  expect(result.message).toContain(message)
  expect(fixture.callTool).toHaveBeenCalledExactlyOnceWith({ name: 'exec', arguments: { command: 'search_tools', arguments: { query: 'get_feature_coverage' } } }, { timeout: 1234 })
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.transportClose).toHaveBeenCalledOnce()
})
