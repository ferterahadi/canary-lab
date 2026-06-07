#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import { runAsScript } from './run-as-script'

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
    copyDir(op.from, op.to)
    log(`Installed ${op.label}: ${op.to}`)
  }

  if (!printConfig) return

  log('')
  log('MCP command for local clients:')
  log('  npx -y canary-lab mcp --profile full')
  log('')
  log('Codex config snippet:')
  log('[mcp_servers.canary_lab]')
  log('command = "npx"')
  log('args = ["-y", "canary-lab", "mcp", "--profile", "full"]')
  log('')
  log('Claude Code config snippet:')
  log(JSON.stringify({
    mcpServers: {
      'canary-lab': {
        command: 'npx',
        args: ['-y', 'canary-lab', 'mcp', '--profile', 'full'],
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
      copyDir(op.from, op.to)
      log(`Updated ${op.label}: ${op.to}`)
      changed += 1
      continue
    }
    copyDir(op.from, op.to)
    log(`Installed ${op.label}: ${op.to}`)
    changed += 1
  }

  return changed
}

export function refreshInstalled(target: Target, opts: AgentInstallOptions = {}): number {
  const home = opts.homeDir ?? os.homedir()
  const log = opts.log ?? console.log
  const assets = resolveAgentAssetsDir()
  let updated = 0

  for (const op of buildOperations(target, home, assets)) {
    if (!fs.existsSync(op.from)) throw new Error(`missing packaged asset: ${op.from}`)
    if (!fs.existsSync(op.to)) continue
    if (dirsEqual(op.from, op.to)) continue
    fs.rmSync(op.to, { recursive: true, force: true })
    copyDir(op.from, op.to)
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
  opts: { homeDir?: string; log?: (msg: string) => void } = {},
): number {
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

function buildOperations(target: Target, home: string, assets: string): AgentOperation[] {
  const operations: AgentOperation[] = []
  if (target === 'codex' || target === 'all') {
    operations.push({
      label: 'Codex skill',
      from: path.join(assets, 'codex', 'skills', 'canary-lab'),
      to: path.join(home, '.codex', 'skills', 'canary-lab'),
    })
  }
  if (target === 'claude' || target === 'all') {
    operations.push({
      label: 'Claude skill',
      from: path.join(assets, 'claude', 'skills', 'canary-lab'),
      to: path.join(home, '.claude', 'skills', 'canary-lab'),
    })
  }
  operations.push({
    label: 'Canary Lab plugin bundle',
    from: path.join(assets, 'plugin', 'canary-lab'),
    to: path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin'),
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
  const candidates = [
    path.resolve(__dirname, '..', 'agent-integrations'),
    path.resolve(__dirname, '..', '..', 'agent-integrations'),
  ]
  const found = candidates.find((dir) => fs.existsSync(dir))
  if (!found) throw new Error('could not locate packaged agent integrations')
  return found
}

function copyDir(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDir(source, target)
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target)
    }
  }
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
