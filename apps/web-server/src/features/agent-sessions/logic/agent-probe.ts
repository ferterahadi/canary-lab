import { execFile } from 'child_process'
import { resolveAgentBinary, type AgentResolveDeps, type HealAgent } from './agent-binary'

/**
 * CLI health probe behind the model-cockpit UI (settings matrix + launch gate).
 *
 * Informational only, never a gate: a launch proceeds whatever this reports —
 * the probe exists so a warning strip can say *why* a spawn is about to run on
 * a broken CLI and what fixes it. Neither CLI can enumerate its models
 * headlessly (verified against claude 2.1.250 / codex 0.149.0), so the probe
 * reports presence, auth, and version — the model dropdowns are curated data
 * in agent-models.ts.
 */

export type AgentProbeState = 'ok' | 'auth' | 'missing'

export interface AgentProbe {
  agent: HealAgent
  state: AgentProbeState
  binaryPath: string | null
  version: string | null
  /** One-line fix for the warning strip; null when state is `ok`. */
  remedy: string | null
}

export interface AgentProbeSnapshot {
  probedAt: string
  claude: AgentProbe
  codex: AgentProbe
}

/** Runs one CLI invocation; `ok` mirrors exit 0. Failure text is irrelevant —
 *  every caller decides from `ok` + stdout. */
export type ProbeExec = (binary: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>

const EXEC_TIMEOUT_MS = 15_000

function defaultExec(binary: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    // With `encoding: 'utf-8'` the callback's stdout is always a string —
    // Node passes '' on spawn failure — so no null-guard is needed.
    execFile(binary, args, { encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      resolve({ ok: !err, stdout })
    })
  })
}

export interface AgentProbeDeps {
  exec?: ProbeExec
  resolve?: AgentResolveDeps
  now?: () => Date
}

const REMEDY = {
  missing: {
    claude: 'Install the Claude Code CLI (`claude`), or point CANARY_LAB_CLAUDE_BIN at it.',
    codex: 'Install the Codex CLI (`codex`), or point CANARY_LAB_CODEX_BIN at it.',
  },
  auth: {
    claude: 'The `claude` CLI is installed but signed out — run `claude` and sign in.',
    codex: 'The `codex` CLI is installed but signed out — run `codex login`.',
  },
} as const

/** `claude auth status` prints JSON with a `loggedIn` boolean; anything else
 *  (non-zero exit, non-JSON output) reads as signed out. */
function claudeLoggedIn(result: { ok: boolean; stdout: string }): boolean {
  if (!result.ok) return false
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true
  } catch {
    return false
  }
}

async function probeOne(agent: HealAgent, deps: AgentProbeDeps): Promise<AgentProbe> {
  const exec = deps.exec ?? defaultExec
  const binaryPath = resolveAgentBinary(agent, deps.resolve)
  if (!binaryPath) {
    return { agent, state: 'missing', binaryPath: null, version: null, remedy: REMEDY.missing[agent] }
  }

  // Auth + version probe in parallel — independent invocations of the same CLI.
  const [auth, versionOut] = await Promise.all([
    agent === 'claude' ? exec(binaryPath, ['auth', 'status']) : exec(binaryPath, ['login', 'status']),
    exec(binaryPath, ['--version']),
  ])
  const loggedIn = agent === 'claude' ? claudeLoggedIn(auth) : auth.ok
  const version = versionOut.ok ? versionOut.stdout.trim().split('\n')[0] || null : null
  if (!loggedIn) {
    return { agent, state: 'auth', binaryPath, version, remedy: REMEDY.auth[agent] }
  }
  return { agent, state: 'ok', binaryPath, version, remedy: null }
}

export async function probeAgents(deps: AgentProbeDeps = {}): Promise<AgentProbeSnapshot> {
  const now = deps.now ?? (() => new Date())
  const [claude, codex] = await Promise.all([probeOne('claude', deps), probeOne('codex', deps)])
  return { probedAt: now().toISOString(), claude, codex }
}

export interface AgentProbeService {
  /** The cached snapshot when fresh enough, else a new probe. `force` skips the
   *  cache — the UI's explicit re-check button. */
  snapshot(force?: boolean): Promise<AgentProbeSnapshot>
}

// Auth checks shell out to both CLIs (a cold `claude` start takes ~1s), and the
// settings dialog re-mounts its probe strip on every open — a short TTL keeps
// that snappy without ever serving stale data past one edit-verify loop.
const DEFAULT_TTL_MS = 30_000

export function createAgentProbeService(
  deps: AgentProbeDeps & { ttlMs?: number } = {},
): AgentProbeService {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const now = deps.now ?? (() => new Date())
  let cached: { at: number; snapshot: AgentProbeSnapshot } | null = null
  let inFlight: Promise<AgentProbeSnapshot> | null = null

  return {
    async snapshot(force = false): Promise<AgentProbeSnapshot> {
      if (!force && cached && now().getTime() - cached.at < ttlMs) return cached.snapshot
      // Single-flight: concurrent opens share one probe instead of stacking
      // subprocess storms behind a cold cache.
      if (!inFlight) {
        inFlight = probeAgents(deps)
          .then((snapshot) => {
            cached = { at: now().getTime(), snapshot }
            return snapshot
          })
          .finally(() => {
            inFlight = null
          })
      }
      return inFlight
    },
  }
}
