#!/usr/bin/env node

import fs from 'fs'
import { REGISTERED_CANARY_LAB_MCP_PROFILE, resolveCliPath, isTempInstallPath } from './mcp-registration'
import os from 'os'
import path from 'path'
import { runAsScript } from './run-as-script'
import { copyDirRecursive } from '../../shared/lib/copy-dir'

type Target = 'codex' | 'claude' | 'all'
export type AgentInstallTarget = Target

interface AgentInstallOptions {
  dryRun?: boolean
  force?: boolean
  homeDir?: string
  printConfig?: boolean
  log?: (msg: string) => void
  error?: (msg: string) => void
  exit?: (code: number) => void
}

interface AgentOperation {
  from: string
  to: string
  label: string
  /** Which installed unit this op belongs to. `refreshInstalled` treats a group
   *  as one unit rather than each op on its own — see the comment there. */
  group: 'codex' | 'claude' | 'plugin'
}

export async function main(
  argv: string[] = process.argv.slice(2),
  opts: AgentInstallOptions = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    ;(opts.error ?? console.error)(parsed.error)
    exit(1)
    return
  }
  try {
    install(parsed.target, {
      dryRun: parsed.dryRun,
      force: parsed.force,
      homeDir: opts.homeDir,
      log: opts.log,
    })
  } catch (err) {
    ;(opts.error ?? console.error)((err as Error).message)
    exit(1)
  }
}

export function install(target: Target, opts: AgentInstallOptions = {}): void {
  const home = opts.homeDir ?? os.homedir()
  const log = opts.log ?? console.log
  const assets = resolveAgentAssetsDir()
  const dryRun = opts.dryRun ?? false
  const force = opts.force ?? false
  const printConfig = opts.printConfig ?? true

  for (const op of buildOperations(target, home, assets)) {
    if (!fs.existsSync(op.from)) throw new Error(`missing packaged asset: ${op.from}`)
    if (dryRun) {
      log(`[dry-run] copy ${op.label}: ${op.from} -> ${op.to}`)
      continue
    }
    if (fs.existsSync(op.to)) {
      if (!force) throw new Error(`${op.label} already exists at ${op.to}; rerun with --force to replace it`)
      fs.rmSync(op.to, { recursive: true, force: true })
    }
    copyDirRecursive(op.from, op.to)
    log(`Installed ${op.label}: ${op.to}`)
  }

  if (!printConfig) return

  log('')
  log('MCP command for local clients:')
  log(`  npx -y canary-lab mcp --profile ${REGISTERED_CANARY_LAB_MCP_PROFILE}`)
  log('')
  log('Codex config snippet:')
  log('[mcp_servers.Canary_Lab]')
  log('command = "npx"')
  log(`args = ["-y", "canary-lab", "mcp", "--profile", "${REGISTERED_CANARY_LAB_MCP_PROFILE}"]`)
  log('')
  log('Claude Code config snippet:')
  log(JSON.stringify({
    mcpServers: {
      'Canary_Lab': {
        command: 'npx',
        args: ['-y', 'canary-lab', 'mcp', '--profile', REGISTERED_CANARY_LAB_MCP_PROFILE],
        alwaysLoad: true,
      },
    },
  }, null, 2))
}

export function installOrRefresh(target: Target, opts: AgentInstallOptions = {}): number {
  const home = opts.homeDir ?? os.homedir()
  const log = opts.log ?? console.log
  const assets = resolveAgentAssetsDir()
  const dryRun = opts.dryRun ?? false
  const force = opts.force ?? false
  let changed = 0

  for (const op of buildOperations(target, home, assets)) {
    if (!fs.existsSync(op.from)) throw new Error(`missing packaged asset: ${op.from}`)
    if (dryRun) {
      log(`[dry-run] install or refresh ${op.label}: ${op.from} -> ${op.to}`)
      continue
    }
    if (fs.existsSync(op.to)) {
      if (!force && dirsEqual(op.from, op.to)) {
        log(`${op.label} already up to date: ${op.to}`)
        continue
      }
      fs.rmSync(op.to, { recursive: true, force: true })
      copyDirRecursive(op.from, op.to)
      log(`Updated ${op.label}: ${op.to}`)
      changed += 1
      continue
    }
    copyDirRecursive(op.from, op.to)
    log(`Installed ${op.label}: ${op.to}`)
    changed += 1
  }

  return changed
}

/**
 * Bring already-installed integrations up to the running package's version.
 *
 * The unit is the GROUP, not the individual op: a client that has any canary-lab
 * skill installed receives the package's whole current skill set, new members
 * included. Skipping every destination that does not exist looks equivalent and
 * is not — 1.6.0 split the single `canary-lab` skill into seven, so an op-wise
 * refresh left every pre-1.6.0 user with exactly the one they already had,
 * rewritten to 1.6.0 wording that points the agent at `canary-lab-run` and five
 * siblings that were never written to disk. Nothing warns, because from the
 * refresh's side every op it looked at succeeded.
 *
 * A client with nothing installed is still left entirely alone: opting in stays
 * explicit via `canary-lab setup`.
 */
export function refreshInstalled(target: Target, opts: AgentInstallOptions = {}): number {
  const home = opts.homeDir ?? os.homedir()
  const log = opts.log ?? console.log
  const assets = resolveAgentAssetsDir()
  const operations = buildOperations(target, home, assets)
  const installedGroups = new Set(
    operations.filter((op) => fs.existsSync(op.to)).map((op) => op.group),
  )
  let updated = 0

  for (const op of operations) {
    if (!fs.existsSync(op.from)) throw new Error(`missing packaged asset: ${op.from}`)
    if (!installedGroups.has(op.group)) continue
    if (!fs.existsSync(op.to)) {
      copyDirRecursive(op.from, op.to)
      log(`Installed ${op.label}: ${op.to}`)
      updated += 1
      continue
    }
    if (dirsEqual(op.from, op.to)) continue
    fs.rmSync(op.to, { recursive: true, force: true })
    copyDirRecursive(op.from, op.to)
    log(`Updated ${op.label}: ${op.to}`)
    updated += 1
  }

  return updated
}

/**
 * Boot-time convenience used by `canary-lab ui` / `canary-lab mcp`: refresh any
 * already-installed agent skills so they match the running package version,
 * swallowing any error. `refreshInstalled` only rewrites skills that already
 * exist and whose content differs, so this is a cheap no-op when nothing
 * changed — safe to call on every start. Honors CANARY_LAB_AGENT_HOME (tests /
 * CI) before falling back to the real home dir. Returns the number of skills
 * updated (0 when current or on error).
 */
export function refreshAgentIntegrationsQuietly(
  opts: { homeDir?: string; log?: (msg: string) => void; cliPath?: string } = {},
): number {
  // Same structural guard as the MCP refreshes (isTempInstallPath): the installed
  // skills are GLOBAL, so a `ui` booted from a demo/smoke install under the temp dir
  // would overwrite the user's skills with whatever that throwaway tarball carried —
  // observed live, delivering a mid-edit skill file from a dirty build tree.
  if (isTempInstallPath(opts.cliPath ?? resolveCliPath())) {
    opts.log?.('Skipping agent integration refresh — this install lives under the temp directory.')
    return 0
  }
  try {
    return refreshInstalled('all', {
      homeDir: opts.homeDir ?? process.env.CANARY_LAB_AGENT_HOME,
      log: opts.log,
    })
  } catch {
    // Best-effort: a missing/locked asset must never block the server boot.
    return 0
  }
}

/** The packaged skill dirs for one client — enumerated, not hardcoded, so the
 *  split skill set (canary-lab, canary-lab-run, …) installs as one op each and
 *  a future skill ships with no installer edit. */
function packagedSkillNames(assets: string, client: 'codex' | 'claude'): string[] {
  const skillsDir = path.join(assets, client, 'skills')
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function buildOperations(target: Target, home: string, assets: string): AgentOperation[] {
  const operations: AgentOperation[] = []
  if (target === 'codex' || target === 'all') {
    for (const skill of packagedSkillNames(assets, 'codex')) {
      operations.push({
        label: `Codex skill (${skill})`,
        from: path.join(assets, 'codex', 'skills', skill),
        to: path.join(home, '.codex', 'skills', skill),
        group: 'codex',
      })
    }
  }
  if (target === 'claude' || target === 'all') {
    for (const skill of packagedSkillNames(assets, 'claude')) {
      operations.push({
        label: `Claude skill (${skill})`,
        from: path.join(assets, 'claude', 'skills', skill),
        to: path.join(home, '.claude', 'skills', skill),
        group: 'claude',
      })
    }
  }
  operations.push({
    label: 'Canary Lab plugin bundle',
    from: path.join(assets, 'plugin', 'canary-lab'),
    to: path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin'),
    group: 'plugin',
  })
  return operations
}

function parseArgs(argv: string[]):
  | { ok: true; target: Target; dryRun: boolean; force: boolean }
  | { ok: false; error: string } {
  if (argv[0] !== 'install') {
    return { ok: false, error: 'Usage: canary-lab agent install <codex|claude|all> [--dry-run] [--force]' }
  }
  const target = argv[1]
  if (target !== 'codex' && target !== 'claude' && target !== 'all') {
    return { ok: false, error: 'Usage: canary-lab agent install <codex|claude|all> [--dry-run] [--force]' }
  }
  let dryRun = false
  let force = false
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    return { ok: false, error: `Unknown canary-lab agent argument: ${arg}` }
  }
  return { ok: true, target, dryRun, force }
}

function resolveAgentAssetsDir(): string {
  // Two levels up from apps/cli/ reaches the repo root in source and the dist
  // root once compiled (dist/apps/cli/ → dist/). The extra level is a spare for
  // any deeper packaging layout.
  const candidates = [
    path.resolve(__dirname, '..', '..', 'agent-integrations'),
    path.resolve(__dirname, '..', '..', '..', 'agent-integrations'),
  ]
  const found = candidates.find((dir) => fs.existsSync(dir))
  if (!found) throw new Error('could not locate packaged agent integrations')
  return found
}

function dirsEqual(leftDir: string, rightDir: string): boolean {
  const leftEntries = fs.readdirSync(leftDir, { withFileTypes: true })
  const rightEntries = fs.readdirSync(rightDir, { withFileTypes: true })
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]))

  if (leftEntries.length !== rightEntries.length) return false

  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name)
    if (!rightEntry) return false
    if (leftEntry.isDirectory() !== rightEntry.isDirectory()) return false
    if (leftEntry.isFile() !== rightEntry.isFile()) return false

    const left = path.join(leftDir, leftEntry.name)
    const right = path.join(rightDir, rightEntry.name)
    if (leftEntry.isDirectory()) {
      if (!dirsEqual(left, right)) return false
    } else if (leftEntry.isFile()) {
      if (!fs.readFileSync(left).equals(fs.readFileSync(right))) return false
    }
  }

  return true
}

runAsScript(module, main)
