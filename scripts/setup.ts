#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { installOrRefresh, type AgentInstallTarget } from './agent'
import { registerCanaryLabMcp } from './mcp-registration'
import { runAsScript } from './run-as-script'
import { getProjectRoot, looksLikeProjectRoot } from '../shared/runtime/project-root'
import {
  registryPath,
  upsertWorkspace,
} from '../shared/runtime/workspace-registry'

type SetupAgentTarget = 'auto' | AgentInstallTarget
type DetectedAgent = 'codex' | 'claude'

export interface SetupOptions {
  homeDir?: string
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

export interface ParsedArgs {
  workspace?: string
  agent: SetupAgentTarget
  dryRun: boolean
  force: boolean
}

export async function main(
  argv: string[] = process.argv.slice(2),
  opts: SetupOptions = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    ;(opts.error ?? console.error)(parsed.error)
    exit(1)
    return
  }

  try {
    setup(parsed.value, opts)
  } catch (err) {
    ;(opts.error ?? console.error)((err as Error).message)
    exit(1)
  }
}

export function setup(args: ParsedArgs, opts: SetupOptions = {}): void {
  const log = opts.log ?? console.log
  const homeDir = opts.homeDir ?? process.env.CANARY_LAB_AGENT_HOME ?? os.homedir()
  const workspace = path.resolve(args.workspace ?? getProjectRoot())

  if (!looksLikeProjectRoot(workspace)) {
    throw new Error(`Not a Canary Lab workspace: ${workspace}`)
  }

  if (args.dryRun) {
    log(`[dry-run] register workspace: ${workspace} -> ${registryPath(homeDir)}`)
  } else {
    const entry = upsertWorkspace(workspace, { homeDir })
    log(`Registered workspace "${entry.name}": ${entry.path}`)
  }

  const target = resolveAgentTarget(args.agent, homeDir)
  if (!target) {
    log('No Codex or Claude installation detected. Skipping agent integration setup.')
    return
  }

  installOrRefresh(target, {
    homeDir,
    dryRun: args.dryRun,
    force: args.force,
    log,
  })
  registerMcpTargets(target, {
    dryRun: args.dryRun,
    force: args.force,
    log,
  })
}

export function parseArgs(argv: string[]):
  | { ok: true; value: ParsedArgs }
  | { ok: false; error: string } {
  const parsed: ParsedArgs = {
    agent: 'auto',
    dryRun: false,
    force: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace') {
      const value = argv[i + 1]
      if (!value) return { ok: false, error: usage() }
      parsed.workspace = value
      i += 1
      continue
    }
    if (arg === '--agent') {
      const value = argv[i + 1]
      if (!isSetupAgentTarget(value)) return { ok: false, error: usage() }
      parsed.agent = value
      i += 1
      continue
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    if (arg === '--force') {
      parsed.force = true
      continue
    }
    return { ok: false, error: `Unknown canary-lab setup argument: ${arg}\n${usage()}` }
  }

  return { ok: true, value: parsed }
}

function resolveAgentTarget(target: SetupAgentTarget, homeDir: string): AgentInstallTarget | null {
  if (target !== 'auto') return target
  const detected = detectAgents(homeDir)
  if (detected.includes('codex') && detected.includes('claude')) return 'all'
  if (detected.includes('codex')) return 'codex'
  if (detected.includes('claude')) return 'claude'
  return null
}

export function detectAgents(homeDir: string = os.homedir()): DetectedAgent[] {
  const agents: DetectedAgent[] = []
  if (commandAvailable('codex') || !!process.env.CODEX_HOME || fs.existsSync(path.join(homeDir, '.codex'))) {
    agents.push('codex')
  }
  if (commandAvailable('claude') || fs.existsSync(path.join(homeDir, '.claude'))) {
    agents.push('claude')
  }
  return agents
}

function commandAvailable(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(lookup, [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isSetupAgentTarget(value: unknown): value is SetupAgentTarget {
  return value === 'auto' || value === 'codex' || value === 'claude' || value === 'all'
}

function usage(): string {
  return 'Usage: canary-lab setup [--workspace <path>] [--agent auto|codex|claude|all] [--dry-run] [--force]'
}

function registerMcpTargets(
  target: AgentInstallTarget,
  opts: { dryRun: boolean; force: boolean; log: (msg: string) => void },
): void {
  if (target === 'codex' || target === 'all') {
    registerCanaryLabMcp('codex', opts)
  }
  if (target === 'claude' || target === 'all') {
    registerCanaryLabMcp('claude', opts)
  }
}

runAsScript(module, main)
