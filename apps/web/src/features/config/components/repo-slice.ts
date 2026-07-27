import type { ConfigValue } from '@/shared/api/client'

/** Derive a repo's display name from its localPath basename, falling back
 *  to the cloneUrl basename (strip `.git`). Returns '' if neither yields one. */
export function deriveRepoName(localPath: ProbePath, cloneUrl: string | undefined): string {
  if (typeof localPath === 'string' && localPath.trim()) {
    const base = localPath.replace(/\/$/, '').split('/').pop()
    if (base) return base
  }
  if (cloneUrl) {
    const match = /([^/:]+?)(?:\.git)?\/?$/.test(cloneUrl)
      ? cloneUrl.replace(/\/$/, '').replace(/\.git$/, '').split(/[/:]/).pop()
      : null
    if (match) return match
  }
  return ''
}

export function nextRepoName(
  currentName: string,
  currentDerivedName: string,
  nextLocalPath: ProbePath,
  cloneUrl: string | undefined,
): string {
  return currentName && currentName !== currentDerivedName
    ? currentName
    : deriveRepoName(nextLocalPath, cloneUrl)
}

export function sameProbePath(a: ProbePath, b: ProbePath): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.$expr === b.$expr
}

// ─── slice types ─────────────────────────────────────────────────────────

export type ProbePath = string | { $expr: string }

export interface HttpProbe { url: string; timeoutMs?: number; deadlineMs?: number }

export interface TcpProbe { port: number; host?: string; timeoutMs?: number; deadlineMs?: number }

export type Probe = { type: 'http'; http: HttpProbe } | { type: 'tcp'; tcp: TcpProbe }

export type Health =
  | { mode: 'none' }
  | { mode: 'single'; probe: Probe }
  | { mode: 'per-env'; byEnv: Record<string, Probe> }

export interface PortSlotSlice {
  name: string
  env?: string
}

export interface CommandSlice {
  name: string
  command: string
  envs?: string[]
  ports?: PortSlotSlice[]
  health: Health
}

export interface RepoSlice {
  name: string
  localPath: ProbePath
  cloneUrl?: string
  branch?: string
  envs?: string[]
  startCommands: CommandSlice[]
}

// ─── parsers ──────────────────────────────────────────────────────────────

export function parseProbe(v: ConfigValue | undefined): Probe | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  if ('http' in obj && obj.http && typeof obj.http === 'object' && !Array.isArray(obj.http)) {
    const h = obj.http as { [k: string]: ConfigValue }
    return {
      type: 'http',
      http: {
        url: typeof h.url === 'string' ? h.url : '',
        ...(typeof h.timeoutMs === 'number' ? { timeoutMs: h.timeoutMs } : {}),
        ...(typeof h.deadlineMs === 'number' ? { deadlineMs: h.deadlineMs } : {}),
      },
    }
  }
  if ('tcp' in obj && obj.tcp && typeof obj.tcp === 'object' && !Array.isArray(obj.tcp)) {
    const t = obj.tcp as { [k: string]: ConfigValue }
    return {
      type: 'tcp',
      tcp: {
        port: typeof t.port === 'number' ? t.port : 0,
        ...(typeof t.host === 'string' ? { host: t.host } : {}),
        ...(typeof t.timeoutMs === 'number' ? { timeoutMs: t.timeoutMs } : {}),
        ...(typeof t.deadlineMs === 'number' ? { deadlineMs: t.deadlineMs } : {}),
      },
    }
  }
  return null
}

export function parseHealth(v: ConfigValue | undefined): Health {
  if (!v) return { mode: 'none' }
  const single = parseProbe(v)
  if (single) return { mode: 'single', probe: single }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const byEnv: Record<string, Probe> = {}
    for (const [k, child] of Object.entries(v)) {
      const p = parseProbe(child)
      if (p) byEnv[k] = p
    }
    if (Object.keys(byEnv).length > 0) return { mode: 'per-env', byEnv }
  }
  return { mode: 'none' }
}

export function parsePorts(v: ConfigValue | undefined): PortSlotSlice[] | undefined {
  if (!Array.isArray(v)) return undefined
  const slots = v
    .map((item): PortSlotSlice | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const obj = item as { [k: string]: ConfigValue }
      if (typeof obj.name !== 'string') return null
      return {
        name: obj.name,
        ...(typeof obj.env === 'string' ? { env: obj.env } : {}),
      }
    })
    .filter((s): s is PortSlotSlice => s != null)
  return slots.length > 0 ? slots : undefined
}

export function parseCommand(v: ConfigValue): CommandSlice | null {
  if (typeof v === 'string') {
    return { name: '', command: v, health: { mode: 'none' } }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    command: typeof obj.command === 'string' ? obj.command : '',
    envs: Array.isArray(obj.envs)
      ? obj.envs.filter((x): x is string => typeof x === 'string')
      : undefined,
    ports: parsePorts(obj.ports),
    health: parseHealth(obj.healthCheck),
  }
}

export function parseRepo(v: ConfigValue): RepoSlice | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const obj = v as { [k: string]: ConfigValue }
  const lp = obj.localPath
  const localPath: ProbePath = (() => {
    if (typeof lp === 'string') return lp
    if (lp && typeof lp === 'object' && !Array.isArray(lp) && '$expr' in lp) {
      return { $expr: (lp as { $expr: string }).$expr }
    }
    return ''
  })()
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    localPath,
    cloneUrl: typeof obj.cloneUrl === 'string' ? obj.cloneUrl : undefined,
    branch: typeof obj.branch === 'string' ? obj.branch : undefined,
    envs: Array.isArray(obj.envs)
      ? obj.envs.filter((x): x is string => typeof x === 'string')
      : undefined,
    startCommands: Array.isArray(obj.startCommands)
      ? obj.startCommands.map(parseCommand).filter((c): c is CommandSlice => c != null)
      : [],
  }
}

// ─── serializers ──────────────────────────────────────────────────────────

export function serializeProbe(p: Probe): ConfigValue {
  if (p.type === 'http') {
    const out: { [k: string]: ConfigValue } = { url: p.http.url }
    if (p.http.timeoutMs != null) out.timeoutMs = p.http.timeoutMs
    if (p.http.deadlineMs != null) out.deadlineMs = p.http.deadlineMs
    return { http: out }
  }
  const out: { [k: string]: ConfigValue } = { port: p.tcp.port }
  if (p.tcp.host) out.host = p.tcp.host
  if (p.tcp.timeoutMs != null) out.timeoutMs = p.tcp.timeoutMs
  if (p.tcp.deadlineMs != null) out.deadlineMs = p.tcp.deadlineMs
  return { tcp: out }
}

export function serializeHealth(h: Health): ConfigValue | undefined {
  if (h.mode === 'none') return undefined
  if (h.mode === 'single') return serializeProbe(h.probe)
  const out: { [k: string]: ConfigValue } = {}
  for (const [k, p] of Object.entries(h.byEnv)) out[k] = serializeProbe(p)
  return out
}

export function serializePorts(ports: PortSlotSlice[] | undefined): ConfigValue | undefined {
  if (!ports) return undefined
  const slots = ports
    .filter((p) => p.name.trim())
    .map((p): ConfigValue => {
      const out: { [k: string]: ConfigValue } = { name: p.name.trim() }
      if (p.env && p.env.trim()) out.env = p.env.trim()
      return out
    })
  return slots.length > 0 ? slots : undefined
}

export function serializeCommand(c: CommandSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = { command: c.command }
  if (c.name) out.name = c.name
  if (c.envs && c.envs.length > 0) out.envs = c.envs
  const ports = serializePorts(c.ports)
  if (ports !== undefined) out.ports = ports
  const hc = serializeHealth(c.health)
  if (hc !== undefined) out.healthCheck = hc
  return out
}

export function serializeRepo(r: RepoSlice): ConfigValue {
  const out: { [k: string]: ConfigValue } = {
    name: r.name,
    localPath: r.localPath as ConfigValue,
  }
  if (r.cloneUrl) out.cloneUrl = r.cloneUrl
  if (r.branch) out.branch = r.branch
  if (r.envs && r.envs.length > 0) out.envs = r.envs
  if (r.startCommands.length > 0) out.startCommands = r.startCommands.map(serializeCommand)
  return out
}

// ─── component ────────────────────────────────────────────────────────────

export interface Slice {
  repos: RepoSlice[]
  rootEnvs: string[] // top-level envs[] used for the per-env health-check editor
}

export interface RepoSummary {
  path: string
  branch?: string
  ports: string[]
  health?: string
  command?: string
}

export function summarizeRepo(repo: RepoSlice): RepoSummary {
  const path = typeof repo.localPath === 'string'
    ? (repo.localPath.replace(/\/$/, '').split('/').pop() || repo.localPath)
    : 'expr'
  const ports = repo.startCommands
    .flatMap((c) => (c.ports ?? []).map((p) => p.name.trim()))
    .filter((n): n is string => Boolean(n))
  const healthCmd = repo.startCommands.find((c) => c.health.mode !== 'none')
  const health = ((): string | undefined => {
    const h = healthCmd?.health
    if (!h || h.mode === 'none') return undefined
    if (h.mode === 'per-env') return 'per-env'
    return h.probe.type === 'http' ? (h.probe.http.url || 'http') : `tcp:${h.probe.tcp.port}`
  })()
  const command = repo.startCommands.map((c) => c.command.trim()).filter(Boolean)[0]
  return { path, branch: repo.branch, ports, health, command }
}
