#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { installOrRefresh, type AgentInstallTarget } from './agent'
import {
  isTempInstallPath,
  registerCanaryLabMcp,
  resolveCliPath,
  readRegisteredMcp,
  type McpRegistrationResult,
  type ResolvedMcpInvocation,
} from './mcp-registration'
import {
  registerClaudeDesktopMcp,
  claudeDesktopConfigPath,
  claudeDesktopInstalled,
  readDesktopMcp,
} from './desktop-registration'
import { verifySavedMcpRegistration, type SavedMcpVerificationOptions, type VerifyResult } from './mcp-verify'
import { readMcpConfig } from './mcp-config'
import { runAsScript } from './run-as-script'
import { getProjectRoot, looksLikeProjectRoot } from '../../shared/runtime/project-root'
import {
  registryPath,
  upsertWorkspace,
} from '../../shared/runtime/workspace-registry'

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
  /** Verification hook. Defaults to probing the saved command over stdio. */
  verifyMcp?: (invocation: ResolvedMcpInvocation, options: SavedMcpVerificationOptions) => VerifyResult | Promise<VerifyResult>
}

export interface ParsedArgs {
  workspace?: string
  agent: SetupAgentTarget
  dryRun: boolean
  force: boolean
  /** Set by programmatic callers (`init`), never by the CLI parser. The
   *  temp-install guard below only binds implicit runs: a user who TYPES
   *  `npx canary-lab setup` in a temp workspace has stated exactly what they
   *  want, and skipping would
   *  make that instruction a silent no-op. */
  implicit?: boolean
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
    await setup(parsed.value, opts)
  } catch (err) {
    ;(opts.error ?? console.error)((err as Error).message)
    exit(1)
  }
}

export async function setup(args: ParsedArgs, opts: SetupOptions = {}): Promise<void> {
  const log = opts.log ?? console.log
  const homeDir = opts.homeDir ?? process.env.CANARY_LAB_AGENT_HOME ?? os.homedir()
  const workspace = path.resolve(args.workspace ?? getProjectRoot())

  if (!looksLikeProjectRoot(workspace)) {
    throw new Error(`Not a Canary Lab workspace: ${workspace}`)
  }

  const execPath = opts.execPath ?? process.execPath
  const cliPath = opts.cliPath ?? resolveCliPath()
  const registrations: Array<{ label: string; result: McpRegistrationResult; gui?: boolean }> = []

  // `claude mcp add` / `codex mcp add` write to the real client configs
  // (~/.claude.json, ~/.codex) regardless of CANARY_LAB_HOME — those shell out
  // to the client CLIs, which don't honor our home override. The tarball smoke
  // test runs `init` against a throwaway temp install, so without this guard it
  // registers a temp `cli.js` path into the user's live client config; once the
  // temp dir is GC'd that entry dangles ("Server disconnected"). Skip-flag lets
  // the smoke test exercise scaffolding + skill install without touching them.
  // ...and the same STRUCTURAL guard the refreshes carry (see isTempInstallPath) —
  // but only for IMPLICIT runs. The env flag above only protects harnesses that
  // remember to set it; a demo or smoke workspace scaffolded under the OS temp dir
  // reaches `setup` through `init` without it, and the temp `cli.js` it registers
  // dies with the next temp sweep. Observed live: a global Canary_Lab entry aimed
  // at a `/private/var/folders/.../T/canary-lab-demo-*/` cli.js. An EXPLICIT
  // `npx canary-lab setup` in a temp workspace is different: the user ran that
  // command explicitly, so it must register (the entry
  // still rots with the workspace — warned below, and the stale-path check plus
  // the `ui`-boot/upgrade heals catch it afterwards).
  const skipClientMcpReason = process.env.CANARY_LAB_SKIP_CLIENT_MCP === '1'
    ? 'CANARY_LAB_SKIP_CLIENT_MCP=1'
    : args.implicit && isTempInstallPath(cliPath)
      ? `this install lives under the temp directory (${cliPath})`
      : null
  const skipClientMcp = skipClientMcpReason !== null
  if (!skipClientMcp && isTempInstallPath(cliPath)) {
    log('Note: this install lives under the temp directory — the registration dies with it. Re-run setup when you move to a new workspace.')
  }

  const target = resolveAgentTarget(args.agent, homeDir)
  const desktopConfigPath = opts.claudeDesktopConfigPath ?? claudeDesktopConfigPath(homeDir)
  const desktopInstalled = !skipClientMcp && claudeDesktopInstalled(desktopConfigPath)
  // Validate JSON before registering the workspace or replacing any skills.
  if (desktopInstalled) readMcpConfig(desktopConfigPath)
  if (!skipClientMcp && (target === 'claude' || target === 'all')) readRegisteredMcp('claude', { homeDir })
  if (!skipClientMcp && (target === 'codex' || target === 'all') && commandAvailable('codex')) readRegisteredMcp('codex', { homeDir })

  if (args.dryRun) {
    log(`[dry-run] register workspace: ${workspace} -> ${registryPath(homeDir)}`)
  } else {
    const entry = upsertWorkspace(workspace, { homeDir })
    log(`Registered workspace "${entry.name}": ${entry.path}`)
  }
  if (target) {
    installOrRefresh(target, {
      homeDir,
      dryRun: args.dryRun,
      force: args.force,
      log,
    })
    if (skipClientMcp) {
      log(`Skipping client MCP registration — ${skipClientMcpReason}.`)
    } else {
      registrations.push(...registerMcpTargets(target, {
        dryRun: args.dryRun,
        force: args.force,
        log,
        execPath,
        cliPath,
        homeDir,
      }))
    }
  } else {
    log('No Codex or Claude installation detected. Skipping agent integration setup.')
  }

  // Claude Desktop keeps MCP servers in its own config file, not via
  // `claude mcp add`, so configure it independently whenever it is installed.
  if (desktopInstalled) {
    const status = registerClaudeDesktopMcp({
      dryRun: args.dryRun,
      force: args.force,
      log,
      configPath: desktopConfigPath,
      execPath,
      cliPath,
      // Pin the workspace `setup` was run in. Desktop has no cwd, so this is the
      // only way a GUI session reaches THIS workspace when more than one server
      // is live — and it is what makes the documented demo hand-off work from a
      // session rooted anywhere.
      projectRoot: workspace,
    })
    if (!args.dryRun) {
      const saved = readDesktopMcp(desktopConfigPath)
      registrations.push({ label: 'Claude Desktop', gui: true, result:
        status !== 'skipped' && saved?.invocation && saved.enabled
          ? { status, invocation: saved.invocation }
          : { status: 'conflict', reason: 'saved Desktop configuration differs; rerun setup --force' },
      })
      if (status === 'configured') log('Restart Claude Desktop to load its updated MCP configuration.')
    }
  }

  // Verify the registered command actually works, so a broken config fails
  // loudly here rather than as a silent "failed to connect" inside the client.
  if (!args.dryRun) {
    const failures: string[] = []
    for (const registration of registrations) {
      const { result, label, gui } = registration
      if (result.status === 'skipped') continue
      if (result.status === 'conflict') {
        failures.push(`${label}: ${result.reason}`)
        continue
      }
      const verify = opts.verifyMcp ?? verifySavedMcpRegistration
      const verification = await verify(result.invocation, { workspace, gui })
      reportVerification(label, verification, log)
      if (verification.status === 'broken') failures.push(`${label}: ${verification.message}`)
    }
    if (failures.length) throw new Error(`Canary Lab setup verification failed:\n${failures.join('\n')}`)
  }
}

function reportVerification(label: string, result: VerifyResult, log: (msg: string) => void): void {
  if (result.status === 'verified') {
    log(`${label} MCP verified: ${result.message}`)
  } else if (result.status === 'server-down') {
    log(`${label} MCP configured; connection unverified. ${result.message}`)
  } else {
    log(`${label} MCP verification failed — ${result.message}`)
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
  opts: { dryRun: boolean; force: boolean; log: (msg: string) => void; execPath: string; cliPath: string; homeDir: string },
): Array<{ label: string; result: McpRegistrationResult }> {
  const results: Array<{ label: string; result: McpRegistrationResult }> = []
  if (target === 'codex' || target === 'all') {
    results.push({ label: 'Codex', result: registerCanaryLabMcp('codex', opts) })
  }
  if (target === 'claude' || target === 'all') {
    results.push({ label: 'Claude Code', result: registerCanaryLabMcp('claude', opts) })
  }
  return results
}

runAsScript(module, main)
