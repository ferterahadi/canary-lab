#!/usr/bin/env node

import { Readable, Writable } from 'stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { runAsScript } from './run-as-script'
import {
  normalizeCanaryLabMcpProfile,
  type CanaryLabMcpProfile,
} from '../apps/web-server/mcp/tools'

const DEFAULT_MCP_URL = 'http://127.0.0.1:7421/mcp'

export interface McpCommandOptions {
  profile?: CanaryLabMcpProfile
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
  fetch?: typeof fetch
  exit?: (code: number) => void
}

export async function main(
  argv: string[] = process.argv.slice(2),
  opts: McpCommandOptions = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const stderr = opts.stderr ?? process.stderr
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`)
    exit(1)
    return
  }
  if (parsed.command === 'doctor') {
    const ok = await doctor(parsed.url, { ...opts, profile: parsed.profile })
    exit(ok ? 0 : 1)
    return
  }
  const ok = await bridge(parsed.url, { ...opts, profile: parsed.profile })
  if (!ok) exit(1)
}

export async function doctor(url: string, opts: McpCommandOptions = {}): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const stdout = opts.stdout ?? process.stdout
  const fetchFn = opts.fetch ?? fetch
  const profile = opts.profile ?? 'repair'
  const profileUrl = urlWithProfile(url, profile)
  try {
    const healthUrl = healthUrlFor(profileUrl)
    const health = await fetchFn(healthUrl)
    if (!health.ok) throw new Error(`/mcp/health returned ${health.status}`)
    const healthBody = await health.json() as { toolCount?: number }

    const client = new Client(
      { name: 'canary-lab-mcp-doctor', version: '0.0.1' },
      { capabilities: {} },
    )
    const transport = new StreamableHTTPClientTransport(new URL(profileUrl), { fetch: fetchFn })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const names = tools.tools.map((tool) => tool.name)
      for (const required of requiredToolsForProfile(profile)) {
        if (!names.includes(required)) {
          throw new Error(`${required} is missing from tools/list`)
        }
      }
      stdout.write(`Canary Lab MCP is reachable at ${url}\n`)
      stdout.write(`Profile: ${profile}\n`)
      stdout.write(`Required tools: ${requiredToolsForProfile(profile).join(', ')}\n`)
      stdout.write(`Tools: ${names.length} listed (${healthBody.toolCount ?? 'unknown'} registered)\n`)
      return true
    } finally {
      await client.close().catch(() => undefined)
    }
  } catch (err) {
    stderr.write(`Canary Lab MCP doctor failed: ${(err as Error).message}\n`)
    stderr.write(`Start the UI first: canary-lab ui\n`)
    return false
  }
}

export async function bridge(url: string, opts: McpCommandOptions = {}): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetch ?? fetch
  const profileUrl = urlWithProfile(url, opts.profile ?? 'repair')
  try {
    const health = await fetchFn(healthUrlFor(profileUrl))
    if (!health.ok) throw new Error(`/mcp/health returned ${health.status}`)
  } catch (err) {
    stderr.write(`Canary Lab MCP is not reachable at ${url}: ${(err as Error).message}\n`)
    stderr.write(`Start the UI first: canary-lab ui\n`)
    return false
  }

  const stdio = new StdioServerTransport(opts.stdin, opts.stdout)
  const http = new StreamableHTTPClientTransport(new URL(profileUrl), { fetch: fetchFn })

  stdio.onmessage = (message) => {
    forwardMessage(http, message).catch((err) => stdio.onerror?.(err as Error))
  }
  http.onmessage = (message) => {
    if (isInitializeResult(message)) {
      http.setProtocolVersion(message.result.protocolVersion)
    }
    forwardMessage(stdio, message).catch((err) => http.onerror?.(err as Error))
  }
  let closing = false
  const closeBoth = (): void => {
    if (closing) return
    closing = true
    void stdio.close().catch(() => undefined)
    void http.close().catch(() => undefined)
  }
  stdio.onclose = closeBoth
  http.onclose = closeBoth
  stdio.onerror = (err) => stderr.write(`Canary Lab MCP stdio error: ${err.message}\n`)
  http.onerror = (err) => stderr.write(`Canary Lab MCP HTTP error: ${err.message}\n`)

  await http.start()
  await stdio.start()
  return true
}

function parseArgs(argv: string[]):
  | { ok: true; command: 'bridge' | 'doctor'; url: string; profile: CanaryLabMcpProfile }
  | { ok: false; error: string } {
  let command: 'bridge' | 'doctor' = 'bridge'
  let url = DEFAULT_MCP_URL
  let profile: CanaryLabMcpProfile = 'repair'
  const args = [...argv]
  if (args[0] === 'doctor') {
    command = 'doctor'
    args.shift()
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--url') {
      const value = args[i + 1]
      if (!value) return { ok: false, error: 'Usage: canary-lab mcp [doctor] [--url <url>]' }
      url = value
      i += 1
      continue
    }
    if (arg === '--profile') {
      const value = args[i + 1]
      const parsedProfile = normalizeCanaryLabMcpProfile(value)
      if (!value || !parsedProfile) return { ok: false, error: `Invalid MCP profile: ${value ?? ''}` }
      profile = parsedProfile
      i += 1
      continue
    }
    return { ok: false, error: `Unknown canary-lab mcp argument: ${arg}` }
  }
  try {
    // Validate early so stdio mode fails before protocol output starts.
    new URL(url)
  } catch {
    return { ok: false, error: `Invalid MCP URL: ${url}` }
  }
  return { ok: true, command, url, profile }
}

async function forwardMessage(
  transport: { send(message: JSONRPCMessage): Promise<void> },
  message: JSONRPCMessage,
): Promise<void> {
  await transport.send(message)
}

function healthUrlFor(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = parsed.pathname.replace(/\/?$/, '/health')
  parsed.hash = ''
  return parsed.toString()
}

function urlWithProfile(url: string, profile: CanaryLabMcpProfile): string {
  const parsed = new URL(url)
  parsed.searchParams.set('profile', profile)
  return parsed.toString()
}

function requiredToolsForProfile(profile: CanaryLabMcpProfile): string[] {
  if (profile === 'verify') return ['execute_verification']
  if (profile === 'full') return ['wait_for_heal_task', 'execute_verification']
  return ['wait_for_heal_task']
}

function isInitializeResult(message: JSONRPCMessage): message is JSONRPCMessage & {
  result: { protocolVersion: string }
} {
  return 'result' in message &&
    !!message.result &&
    typeof message.result === 'object' &&
    'protocolVersion' in message.result &&
    typeof (message.result as { protocolVersion?: unknown }).protocolVersion === 'string'
}

runAsScript(module, main)
