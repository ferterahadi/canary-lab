import { execFileSync } from 'child_process'
import type { ResolvedMcpInvocation } from './mcp-registration'

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
  if (exitCode === 0 && text.includes('reachable')) {
    return { status: 'verified', message: output.trim() }
  }
  if (text.includes('not reachable') || text.includes('start the ui')) {
    return {
      status: 'server-down',
      message: 'MCP is registered but the server is not running. Start it with `canary-lab ui`.',
    }
  }
  return { status: 'broken', message: output.trim() || `doctor exited with code ${exitCode}` }
}

export function verifyMcpRegistration(
  invocation: ResolvedMcpInvocation,
  run: VerifyRunner = defaultRunner,
): VerifyResult {
  const { exitCode, output } = run(
    invocation.command,
    [...invocation.args, 'doctor', '--no-autostart'],
    invocation.env,
  )
  return classifyDoctorOutput(exitCode, output)
}

const defaultRunner: VerifyRunner = (command, args, env) => {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      env: env ? { ...process.env, ...env } : process.env,
    })
    return { exitCode: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const output = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` || e.message || ''
    return { exitCode: typeof e.status === 'number' ? e.status : 1, output }
  }
}
