import fs from 'fs'
import os from 'os'
import path from 'path'
import { registryDir } from './workspace-registry'
import { isUnderTempDir } from './temp-path'

// A record of the Canary Lab UI/MCP HTTP servers currently listening, keyed by
// project root. The single registered MCP bridge reads this to follow whatever
// server is actually running — instead of guessing a port from the most-recent
// workspace — so switching the port (or workspace) no longer strands the bridge
// against a dead port. Entries are pruned when their owning process is gone.
export interface ActiveServerEntry {
  projectRoot: string
  port: number
  pid: number
  updatedAt: string
}

export interface ActiveServersFile {
  version: 1
  servers: ActiveServerEntry[]
}

// Deliberately NOT scoped by CANARY_LAB_HOME. That variable isolates state that
// is the USER'S — the workspace registry and the client registrations — so a
// throwaway demo or smoke test can never clutter or re-point them. Liveness is a
// different kind of fact: "a server is listening on this port right now" is true
// of the machine, it prunes itself when the process dies, and hiding it is what
// forced an MCP client to be launched from inside the workspace before it could
// find its own server. A demo server that nobody can reach from an ordinary
// session is not isolation, it is a discovery hole.
//
// CANARY_LAB_LIVE_REGISTRY_HOME exists for a sandbox that must not write to the
// real home at all; tests pass `homeDir` explicitly instead.
export function liveRegistryHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CANARY_LAB_LIVE_REGISTRY_HOME?.trim()
  return override ? override : os.homedir()
}

export function activeServersPath(homeDir: string = liveRegistryHome()): string {
  return path.join(registryDir(homeDir), 'active-servers.json')
}

export type IsAlive = (pid: number) => boolean

// `kill(pid, 0)` probes without signalling: ESRCH means gone, EPERM means alive
// but owned by another user (still a live server). Local-only, which is exactly
// the scope of these records.
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readRaw(homeDir?: string): ActiveServerEntry[] {
  const file = activeServersPath(homeDir)
  if (!fs.existsSync(file)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ActiveServersFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.servers)) return []
    return parsed.servers.filter(isServerEntry)
  } catch {
    return []
  }
}

function writeFile(entries: ActiveServerEntry[], homeDir?: string): void {
  const file = activeServersPath(homeDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload: ActiveServersFile = { version: 1, servers: entries }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
}

// Live entries only — dead pids are filtered out (and not persisted; the next
// register() rewrites the file without them).
export function readActiveServers(
  opts: { homeDir?: string; isAlive?: IsAlive } = {},
): ActiveServerEntry[] {
  const isAlive = opts.isAlive ?? defaultIsAlive
  return readRaw(opts.homeDir).filter((entry) => isAlive(entry.pid))
}

export function registerActiveServer(
  entry: { projectRoot: string; port: number; pid: number },
  opts: { homeDir?: string; now?: Date; isAlive?: IsAlive } = {},
): void {
  const resolved = path.resolve(entry.projectRoot)
  const now = (opts.now ?? new Date()).toISOString()
  const isAlive = opts.isAlive ?? defaultIsAlive
  const kept = readRaw(opts.homeDir).filter(
    (existing) =>
      existing.pid !== entry.pid &&
      !samePath(existing.projectRoot, resolved) &&
      isAlive(existing.pid),
  )
  writeFile([...kept, { projectRoot: resolved, port: entry.port, pid: entry.pid, updatedAt: now }], opts.homeDir)
}

export function unregisterActiveServer(
  match: { pid?: number; projectRoot?: string },
  opts: { homeDir?: string } = {},
): void {
  const file = activeServersPath(opts.homeDir)
  if (!fs.existsSync(file)) return
  const resolvedRoot = match.projectRoot ? path.resolve(match.projectRoot) : undefined
  const kept = readRaw(opts.homeDir).filter((entry) => {
    if (match.pid !== undefined && entry.pid === match.pid) return false
    if (resolvedRoot !== undefined && samePath(entry.projectRoot, resolvedRoot)) return false
    return true
  })
  writeFile(kept, opts.homeDir)
}

// Pick the live server the caller most likely means: an explicit project-root
// env wins, else the server enclosing the cwd (nearest root), else the most
// recently registered durable workspace — a temp project root only wins when it
// is the sole live server. Mirrors the bridge's existing autostart resolution
// priority so behaviour is consistent.
export function resolveActiveServer(
  opts: {
    homeDir?: string
    cwd?: string
    env?: NodeJS.ProcessEnv
    servers?: ActiveServerEntry[]
    isAlive?: IsAlive
  } = {},
): ActiveServerEntry | null {
  const servers = opts.servers ?? readActiveServers({ homeDir: opts.homeDir, isAlive: opts.isAlive })
  if (servers.length === 0) return null

  const env = opts.env ?? process.env
  const explicit = env.CANARY_LAB_PROJECT_ROOT?.trim()
  if (explicit) {
    const resolved = path.resolve(explicit)
    const match = servers.find((server) => samePath(server.projectRoot, resolved))
    if (match) return match
  }

  if (opts.cwd) {
    const cwd = path.resolve(opts.cwd)
    const enclosing = servers
      .filter((server) => isAtOrUnder(cwd, server.projectRoot))
      .sort((a, b) => b.projectRoot.length - a.projectRoot.length)[0]
    if (enclosing) return enclosing
  }

  // Nothing pinned this and nothing encloses the cwd, so the pick is a guess —
  // make it the least destructive one. A server whose project root is under the
  // OS temp dir is a demo or a smoke test: reachable, but a folder the OS may
  // delete, so it loses to any durable workspace and wins only when it is the
  // only thing running. Newest-first within each group keeps the previous
  // behaviour for the ordinary single-workspace case.
  const byRecency = [...servers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return byRecency.find((server) => !isUnderTempDir(server.projectRoot)) ?? byRecency[0]
}

function isAtOrUnder(child: string, parent: string): boolean {
  const c = path.normalize(child)
  const p = path.normalize(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

function samePath(left: string, right: string): boolean {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isServerEntry(value: unknown): value is ActiveServerEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ActiveServerEntry>
  return typeof candidate.projectRoot === 'string' &&
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    typeof candidate.updatedAt === 'string'
}
