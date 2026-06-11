import fs from 'fs'
import os from 'os'
import path from 'path'

export interface CanaryLabWorkspace {
  name: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface CanaryLabWorkspaceRegistry {
  version: 1
  workspaces: CanaryLabWorkspace[]
}

// The directory that holds Canary Lab's user-level state (workspace registry,
// active-server records, agent integrations). Defaults to the home dir, but an
// explicit CANARY_LAB_HOME wins so isolated processes — smoke tests, CI — never
// touch the real `~/.canary-lab`.
export function canaryLabHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CANARY_LAB_HOME?.trim()
  return override ? override : os.homedir()
}

export function registryDir(homeDir: string = canaryLabHome()): string {
  return path.join(homeDir, '.canary-lab')
}

export function registryPath(homeDir: string = canaryLabHome()): string {
  return path.join(registryDir(homeDir), 'workspaces.json')
}

export function emptyRegistry(): CanaryLabWorkspaceRegistry {
  return { version: 1, workspaces: [] }
}

export function readWorkspaceRegistry(homeDir?: string): CanaryLabWorkspaceRegistry {
  const file = registryPath(homeDir)
  if (!fs.existsSync(file)) return emptyRegistry()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CanaryLabWorkspaceRegistry>
    if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) return emptyRegistry()
    return {
      version: 1,
      workspaces: parsed.workspaces.filter(isWorkspaceEntry),
    }
  } catch {
    return emptyRegistry()
  }
}

export function writeWorkspaceRegistry(
  registry: CanaryLabWorkspaceRegistry,
  homeDir?: string,
): void {
  const file = registryPath(homeDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n')
}

export function upsertWorkspace(
  workspacePath: string,
  opts: { homeDir?: string; now?: Date } = {},
): CanaryLabWorkspace {
  const resolved = realpathOrResolve(workspacePath)
  const now = (opts.now ?? new Date()).toISOString()
  const registry = readWorkspaceRegistry(opts.homeDir)
  // GC entries whose path has vanished (deleted temp/smoke workspaces) so the
  // recency heuristic and bridge resolution never chase a dead directory. The
  // workspace being upserted is always kept, even on a transiently-missing
  // mount, because it is re-added below.
  registry.workspaces = registry.workspaces.filter(
    (workspace) => samePath(workspace.path, resolved) || fs.existsSync(workspace.path),
  )
  const existing = registry.workspaces.find((workspace) => samePath(workspace.path, resolved))

  if (existing) {
    existing.name = path.basename(resolved)
    existing.path = resolved
    existing.updatedAt = now
    writeWorkspaceRegistry(registry, opts.homeDir)
    return existing
  }

  const entry: CanaryLabWorkspace = {
    name: path.basename(resolved),
    path: resolved,
    createdAt: now,
    updatedAt: now,
  }
  registry.workspaces.push(entry)
  registry.workspaces.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  writeWorkspaceRegistry(registry, opts.homeDir)
  return entry
}

function realpathOrResolve(candidate: string): string {
  const resolved = path.resolve(candidate)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function isWorkspaceEntry(value: unknown): value is CanaryLabWorkspace {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CanaryLabWorkspace>
  return typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
}
