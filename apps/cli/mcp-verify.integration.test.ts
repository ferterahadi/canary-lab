import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifySavedMcpRegistration } from './mcp-verify'

const requireModule = createRequire(import.meta.url)
let root: string
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-saved-mcp-'))) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function server(tool = 'exec', discover = true): string {
  const file = path.join(root, 'server.cjs')
  fs.writeFileSync(file, `
const { McpServer } = require(${JSON.stringify(requireModule.resolve('@modelcontextprotocol/server'))});
const { serveStdio } = require(${JSON.stringify(requireModule.resolve('@modelcontextprotocol/server/stdio'))});
const { z } = require(${JSON.stringify(requireModule.resolve('zod'))});
const fs = require('fs');
serveStdio(() => {
const server = new McpServer({name:'setup-fixture', version:'1.0.0'});
server.registerTool(${JSON.stringify(tool)}, { inputSchema: z.object({command:z.string(), arguments:z.record(z.string(),z.unknown())}) }, async () => {
  fs.writeFileSync(process.env.PROBE_RECEIPT, JSON.stringify({cwd:process.cwd(), value:process.env.PROBE_VALUE, args:process.argv}));
  return {content:[{type:'text', text:JSON.stringify({matches:${discover ? "[{command:'get_feature_coverage'}]" : '[]'}})}]};
});
return server;
});
`)
  return file
}

function options(workspace = root) {
  return {
    workspace,
    timeoutMs: 1000,
    run: vi.fn(() => ({ exitCode: 0, output: 'Canary Lab MCP is reachable at http://127.0.0.1:12345/mcp\n' })),
    fetch: vi.fn(async () => new Response(JSON.stringify({ projectRoot: workspace }))),
  }
}

describe('saved MCP launch verification', () => {
  it('launches the real saved command with its environment and cwd and discovers exec commands', async () => {
    const receipt = path.join(root, 'receipt.json')
    const cwd = path.join(root, 'client-cwd')
    fs.mkdirSync(cwd)
    const opts = options()
    const script = server()
    const result = await verifySavedMcpRegistration({ command: process.execPath, args: [script, 'mcp'], cwd,
      env: { PROBE_RECEIPT: receipt, PROBE_VALUE: 'saved-value' },
    }, opts)
    expect(result.status).toBe('verified')
    expect(opts.run).toHaveBeenCalledWith(process.execPath, [script, 'mcp', 'doctor', '--no-autostart'], expect.objectContaining({ PROBE_VALUE: 'saved-value' }), cwd)
    expect(JSON.parse(fs.readFileSync(receipt, 'utf-8'))).toEqual({ cwd, value: 'saved-value', args: [process.execPath, script, 'mcp', '--no-autostart'] })
  })

  it.each([['old_tool', true, 'compact profile'], ['exec', false, 'discovery failed']] as const)(
    'rejects incompatible tool surface %s', async (tool, discover, message) => {
      const result = await verifySavedMcpRegistration({ command: process.execPath, args: [server(tool, discover)],
        env: { PROBE_RECEIPT: path.join(root, 'receipt.json') },
      }, options())
      expect(result.status).toBe('broken')
      expect(result.message).toContain(message)
    },
  )

  it('rejects a healthy server serving another workspace before launching the bridge', async () => {
    const opts = options()
    opts.fetch.mockResolvedValue(new Response(JSON.stringify({ projectRoot: path.join(root, 'other') })))
    const result = await verifySavedMcpRegistration({ command: '/missing/command', args: [] }, opts)
    expect(result.status).toBe('broken')
    expect(result.message).toContain('expected')
  })

  it('reports an offline UI without launching a bridge or fetching health', async () => {
    const opts = options()
    opts.run.mockReturnValue({ exitCode: 1, output: 'Canary Lab MCP is not reachable at http://127.0.0.1:12345/mcp' })
    const result = await verifySavedMcpRegistration({ command: '/missing/command', args: [] }, opts)
    expect(result.status).toBe('server-down')
    expect(opts.fetch).not.toHaveBeenCalled()
  })

  it('rejects a command which fails to launch even when the doctor preflight succeeded', async () => {
    const result = await verifySavedMcpRegistration({ command: path.join(root, 'missing'), args: [] }, options())
    expect(result.status).toBe('broken')
  })
})
