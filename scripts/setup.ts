#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { installOrRefresh, type AgentInstallTarget } from './agent'
import {
  registerCanaryLabMcp,
  resolveCliPath,
  resolveMcpInvocation,
  type ResolvedMcpInvocation,
} from './mcp-registration'
import {
  registerClaudeDesktopMcp,
  claudeDesktopConfigPath,
  claudeDesktopInstalled,
} from './desktop-registration'
import { verifyMcpRegistration, type VerifyResult } from './mcp-verify'
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
  /** Node binary registered into client configs. Defaults to the running node. */
  execPath?: string
  /** Absolute path to the installed cli.js. Defaults to this build's sibling. */
  cliPath?: string
  /** Override the Claude Desktop config path (testing). Defaults to the per-OS location. */
  claudeDesktopConfigPath?: string
  /** Verification hook. Defaults to probing the registered command with `mcp doctor`. */
  verifyMcp?: (invocation: ResolvedMcpInvocation) => VerifyResult
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

  const execPath = opts.execPath ?? process.execPath
  const cliPath = opts.cliPath ?? resolveCliPath()
  let registered = false

  // `claude mcp add` / `codex mcp add` write to the real client configs
  // (~/.claude.json, ~/.codex) regardless of CANARY_LAB_HOME — those shell out
  // to the client CLIs, which don't honor our home override. The tarball smoke
  // test runs `init` against a throwaway temp install, so without this guard it
  // registers a temp `cli.js` path into the user's live client config; once the
  // temp dir is GC'd that entry dangles ("Server disconnected"). Skip-flag lets
  // the smoke test exercise scaffolding + skill install without touching them.
  const skipClientMcp = process.env.CANARY_LAB_SKIP_CLIENT_MCP === '1'

  const target = resolveAgentTarget(args.agent, homeDir)
  if (target) {
    installOrRefresh(target, {
      homeDir,
      dryRun: args.dryRun,
      force: args.force,
      log,
    })
    if (skipClientMcp) {
      log('Skipping client MCP registration (CANARY_LAB_SKIP_CLIENT_MCP=1).')
    } else {
      registerMcpTargets(target, {
        dryRun: args.dryRun,
        force: args.force,
        log,
        execPath,
        cliPath,
      })
      registered = true
    }
  } else {
    log('No Codex or Claude installation detected. Skipping agent integration setup.')
  }

  // Claude Desktop keeps MCP servers in its own config file, not via
  // `claude mcp add`, so configure it independently whenever it is installed.
  const desktopConfigPath = opts.claudeDesktopConfigPath ?? claudeDesktopConfigPath(homeDir)
  if (!skipClientMcp && claudeDesktopInstalled(desktopConfigPath)) {
    registerClaudeDesktopMcp({
      dryRun: args.dryRun,
      force: args.force,
      log,
      configPath: desktopConfigPath,
      execPath,
      cliPath,
    })
    registered = true
  }

  // Verify the registered command actually works, so a broken config fails
  // loudly here rather than as a silent "failed to connect" inside the client.
  if (registered && !args.dryRun) {
    const verify = opts.verifyMcp ?? verifyMcpRegistration
    reportVerification(verify(resolveMcpInvocation({ execPath, cliPath })), log)
  }
}

function reportVerification(result: VerifyResult, log: (msg: string) => void): void {
  if (result.status === 'verified') {
    log('Verified Canary Lab MCP is reachable.')
  } else if (result.status === 'server-down') {
    log(`Canary Lab MCP configured. ${result.message}`)
  } else {
    log(`WARNING: Canary Lab MCP verification failed — ${result.message}`)
  }
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
  opts: { dryRun: boolean; force: boolean; log: (msg: string) => void; execPath: string; cliPath: string },
): void {
  if (target === 'codex' || target === 'all') {
    registerCanaryLabMcp('codex', opts)
  }
  if (target === 'claude' || target === 'all') {
    registerCanaryLabMcp('claude', opts)
  }
}

runAsScript(module, main)
