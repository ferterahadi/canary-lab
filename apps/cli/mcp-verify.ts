import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import type { ResolvedMcpInvocation } from './mcp-registration'
import { CANARY_LAB_MCP_PROTOCOL_VERSION } from '../../shared/mcp-protocol'

export type VerifyStatus = 'verified' | 'server-down' | 'broken'

export interface VerifyResult {
  status: VerifyStatus
  message: string
}

export interface VerifyRunResult {
  exitCode: number
  output: string
}

export type VerifyRunner = (
  command: string,
  args: string[],
  env?: Record<string, string>,
  cwd?: string,
) => VerifyRunResult

// Turn the registered bridge command's `mcp doctor` output into a verdict so
// `canary-lab setup` can fail loudly instead of leaving a config that only
// surfaces "failed to connect" inside the client later.
export function classifyDoctorOutput(exitCode: number, output: string): VerifyResult {
  const text = output.toLowerCase()
  if (/unknown command|unknown canary-lab|invalid mcp|cannot find module|is not a function/.test(text)) {
    return {
      status: 'broken',
      message: 'the registered command does not support `canary-lab mcp` — likely a version mismatch.',
    }
  }
  if (text.includes('is not reachable')) {
    return {
      status: 'server-down',
      message: 'MCP is registered but the server is not running. Start it with `canary-lab ui`.',
    }
  }
  if (exitCode === 0 && /\breachable\b/.test(text)) {
    return { status: 'verified', message: output.trim() }
  }
  return { status: 'broken', message: output.trim() || `doctor exited with code ${exitCode}` }
}

export function verifyMcpRegistration(
  invocation: ResolvedMcpInvocation,
  run: VerifyRunner = defaultRunner,
): VerifyResult {
  const { exitCode, output } = run(
    invocation.command,
    doctorArgs(invocation.args),
    invocation.env,
    invocation.cwd,
  )
  return classifyDoctorOutput(exitCode, output)
}

export interface SavedMcpVerificationOptions {
  workspace: string
  gui?: boolean
  run?: VerifyRunner
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Probe the saved launch configuration, including a real stdio handshake. The
 * doctor preflight distinguishes a stopped UI from a broken client and resolves
 * the server URL using the child's environment rather than the setup process. */
export async function verifySavedMcpRegistration(
  invocation: ResolvedMcpInvocation,
  opts: SavedMcpVerificationOptions,
): Promise<VerifyResult> {
  const cwd = invocation.cwd ?? (opts.gui ? os.homedir() : opts.workspace)
  const env = { ...(opts.gui ? getDefaultEnvironment() : stringEnvironment()), ...invocation.env }
  // A CLI's explicit routing pin must come from its saved entry, never leak from
  // the shell running setup and hide a missing or incorrect client setting.
  if (!invocation.env?.CANARY_LAB_PROJECT_ROOT) delete env.CANARY_LAB_PROJECT_ROOT
  const saved = { ...invocation, env, cwd }
  const preflight = verifyMcpRegistration(saved, opts.run)
  if (preflight.status !== 'verified') return preflight
  const url = preflight.message.match(/is reachable at (https?:\/\/\S+)/)?.[1]
  if (!url) return { status: 'broken', message: 'MCP diagnostic did not report the server URL.' }

  const timeout = opts.timeoutMs ?? 20_000
  const client = new Client({ name: 'canary-lab-setup', version: '1.0.0' }, {
    capabilities: {},
    versionNegotiation: { mode: { pin: CANARY_LAB_MCP_PROTOCOL_VERSION } },
  })
  const transport = new StdioClientTransport({
    ...saved,
    args: [...saved.args, '--no-autostart'],
    stderr: 'pipe',
  })
  // Drain stderr without putting environment values or client diagnostics in a
  // success receipt. Request errors below identify which saved client failed.
  transport.stderr?.on('data', () => {})
  try {
    const healthUrl = new URL(url)
    healthUrl.pathname = `${healthUrl.pathname.replace(/\/$/, '')}/health`
    const response = await (opts.fetch ?? fetch)(healthUrl, { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`MCP health returned ${response.status}`)
    const health = await response.json() as { projectRoot?: string }
    if (!health.projectRoot || realPath(health.projectRoot) !== realPath(opts.workspace)) {
      throw new Error(`MCP serves ${health.projectRoot ?? 'an unknown workspace'}, expected ${opts.workspace}`)
    }
    await client.connect(transport, { timeout })
    const result = await client.listTools({}, { timeout })
    if (result.tools.length !== 1 || result.tools[0].name !== 'exec') throw new Error('Expected the compact profile with only exec')
    const discovery = await client.callTool({ name: 'exec', arguments: {
      command: 'search_tools', arguments: { query: 'get_feature_coverage' },
    } }, { timeout })
    const content = (discovery as { content?: Array<{ type: string; text?: string }> }).content ?? []
    const parsed = JSON.parse(content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')) as {
      matches?: Array<{ command: string }>
    }
    if (!parsed.matches?.some((match) => match.command === 'get_feature_coverage')) throw new Error('exec command discovery failed')
    return { status: 'verified', message: `compact MCP connected to ${opts.workspace}` }
  } catch (error) {
    return { status: 'broken', message: (error as Error).message }
  } finally {
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function realPath(value: string): string {
  try {
    return fs.realpathSync(path.resolve(value))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(value)
    throw error
  }
}

function doctorArgs(args: string[]): string[] {
  const mcpIndex = args.indexOf('mcp')
  if (mcpIndex === -1) return [...args, 'doctor', '--no-autostart']
  return [
    ...args.slice(0, mcpIndex + 1),
    'doctor',
    ...args.slice(mcpIndex + 1),
    '--no-autostart',
  ]
}

const defaultRunner: VerifyRunner = (command, args, env, cwd) => {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      env: env ?? process.env,
      cwd,
    })
    return { exitCode: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const output = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` || e.message || ''
    return { exitCode: typeof e.status === 'number' ? e.status : 1, output }
  }
}
