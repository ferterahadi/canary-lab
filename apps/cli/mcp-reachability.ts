#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { Writable } from 'stream'
import { type CanaryLabMcpProfile } from '../web-server/src/mcp/tools'
import { type ClientKind } from '../../shared/run-mode'
import { looksLikeProjectRoot } from '../../shared/runtime/project-root'
import {
  canaryLabHome,
  readWorkspaceRegistry,
  type CanaryLabWorkspaceRegistry,
} from '../../shared/runtime/workspace-registry'
import { McpCommandOptions, isDefaultLocalMcpUrl, stripProfile } from './mcp'

export const DEFAULT_UI_STARTUP_TIMEOUT_MS = 15_000

export const DEFAULT_UI_STARTUP_POLL_MS = 250

export async function ensureMcpServerReachable(
  url: string,
  opts: McpCommandOptions = {},
): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetch ?? fetch
  const eligible = opts.autoStartEligible ?? isDefaultLocalMcpUrl(url)
  const firstCheck = await checkHealth(url, fetchFn)
  if (firstCheck.ok) {
    if (
      eligible &&
      firstCheck.projectRoot &&
      !isUsableUiProjectRoot(firstCheck.projectRoot)
    ) {
      stderr.write(`Canary Lab MCP is reachable at ${stripProfile(url)} but is serving unusable projectRoot "${firstCheck.projectRoot}". Stop that server, then run \`canary-lab ui\` from a Canary Lab workspace.\n`)
      return false
    }
    return true
  }

  if (opts.autoStartUi === false || !eligible) {
    stderr.write(`Canary Lab MCP is not reachable at ${stripProfile(url)}: ${firstCheck.error}\n`)
    stderr.write('Start the UI first: canary-lab ui\n')
    return false
  }

  stderr.write('Canary Lab UI is not running; starting `canary-lab ui --no-open`...\n')
  const projectRoot = resolveUiProjectRootForMcpAutostart({
    cwd: opts.cwd ?? process.cwd(),
    homeDir: opts.homeDir,
    registry: opts.registry,
  })
  if (!projectRoot) {
    stderr.write('Cannot auto-start Canary Lab UI because no workspace could be resolved. Run `canary-lab ui` from a Canary Lab workspace, or set CANARY_LAB_PROJECT_ROOT.\n')
    return false
  }
  try {
    await (opts.startUi ?? startUiInBackground)(stderr, projectRoot)
  } catch (err) {
    stderr.write(`Failed to start Canary Lab UI: ${(err as Error).message}\n`)
    stderr.write('Start the UI manually: canary-lab ui\n')
    return false
  }

  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_UI_STARTUP_TIMEOUT_MS
  const pollMs = opts.startupPollMs ?? DEFAULT_UI_STARTUP_POLL_MS
  const deadline = Date.now() + timeoutMs
  let lastError = firstCheck.error
  while (Date.now() <= deadline) {
    await sleep(pollMs)
    const check = await checkHealth(url, fetchFn)
    if (check.ok) return true
    lastError = check.error
  }

  stderr.write(`Canary Lab MCP is not reachable at ${stripProfile(url)} after starting the UI: ${lastError}\n`)
  stderr.write('Start the UI manually: canary-lab ui\n')
  return false
}

export async function checkHealth(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; projectRoot?: string } | { ok: false; error: string }> {
  try {
    const health = await fetchFn(healthUrlFor(url))
    if (!health.ok) return { ok: false, error: `/mcp/health returned ${health.status}` }
    const body = await health.json().catch(() => null) as { projectRoot?: unknown } | null
    return {
      ok: true,
      ...(typeof body?.projectRoot === 'string' ? { projectRoot: body.projectRoot } : {}),
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function startUiInBackground(stderr: Writable, projectRoot: string): void {
  const child = spawn(process.execPath, [resolveCliPath(), 'ui', '--no-open'], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, CANARY_LAB_PROJECT_ROOT: projectRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.write(`[canary-lab ui] ${chunk.toString()}`)
  })
  child.unref()
}

export function resolveUiProjectRootForMcpAutostart(opts: {
  cwd?: string
  homeDir?: string
  registry?: CanaryLabWorkspaceRegistry
} = {}): string | null {
  const explicitRoot = process.env.CANARY_LAB_PROJECT_ROOT
  if (explicitRoot && isUsableUiProjectRoot(explicitRoot)) {
    return path.resolve(explicitRoot)
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const fromCwd = findUsableUiProjectRootUpward(cwd)
  if (fromCwd) return fromCwd

  const registry = opts.registry ?? readWorkspaceRegistry(opts.homeDir ?? canaryLabHome())
  const candidates = registry.workspaces
    .filter((workspace) => isUsableUiProjectRoot(workspace.path))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return candidates[0]?.path ?? null
}

export function findUsableUiProjectRootUpward(start: string): string | null {
  let current = path.resolve(start)
  while (true) {
    if (isUsableUiProjectRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function isUsableUiProjectRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return looksLikeProjectRoot(resolved) || looksLikeCanaryLabPackage(resolved)
}

export function looksLikeCanaryLabPackage(candidate: string): boolean {
  const packageJson = path.join(candidate, 'package.json')
  if (!fs.existsSync(packageJson)) return false
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as { name?: string }
    return parsed.name === 'canary-lab'
  } catch {
    return false
  }
}

export function resolveCliPath(): string {
  const siblingCli = path.join(__dirname, 'cli.js')
  if (fs.existsSync(siblingCli)) return siblingCli
  return process.argv[1] ?? siblingCli
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function healthUrlFor(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = parsed.pathname.replace(/\/?$/, '/health')
  parsed.hash = ''
  return parsed.toString()
}

export function urlWithContext(
  url: string,
  profile: CanaryLabMcpProfile,
  clientKind: ClientKind,
): string {
  const parsed = new URL(url)
  parsed.searchParams.set('profile', profile)
  parsed.searchParams.set('client_kind', clientKind)
  return parsed.toString()
}
