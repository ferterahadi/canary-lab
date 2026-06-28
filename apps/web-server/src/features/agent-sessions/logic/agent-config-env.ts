// Back-fill the agent CLIs' config-dir env vars from the user's interactive
// shell at boot.
//
// `claude` and `codex` let you relocate their config/session home via env vars
// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Canary's session-log locators key off
// `process.env` for these (see `claudeConfigDir` / `codexConfigDir` in
// `agent-session-log.ts`), and so do the spawn paths:
//   - headless agents (coverage/wizard/portify/benchmark) inherit `process.env`
//     directly via `child_process`.
//   - the PTY heal agent runs under `$SHELL -i -c`, which sources the user's rc
//     file (.zshrc/.bashrc).
//
// The gap: if the rc file sets one of these vars but the env that launched the
// server did NOT (e.g. the user exported it only for interactive shells, or
// launched Canary from a context that didn't source the rc), then the PTY agent
// writes its session log to the rc-configured home while the server keeps
// looking under the default — a silently-blank AgentSessionView.
//
// Closing it: probe the interactive shell once at boot for these vars and
// back-fill any that are set there but missing from `process.env`. After that,
// every spawn path AND every read path resolves the same home, because they all
// key off `process.env`. Best-effort — a probe failure just leaves the env as
// it was (the prior, env-aware-default behavior).

import { spawnSync } from 'child_process'

// The vars the agent CLIs read to relocate their config/session home.
const AGENT_CONFIG_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const

const MARKER_START = '__CL_ENV_START__'
const MARKER_END = '__CL_ENV_END__'

// Runs the probe command and returns stdout, or null on any failure/timeout.
export type ShellProbe = (shell: string, args: string[], timeoutMs: number) => string | null

export interface HydrateAgentConfigEnvOptions {
  // The env to read from and back-fill. Defaults to `process.env`.
  env?: NodeJS.ProcessEnv
  // The interactive shell to probe. Defaults to `$SHELL` then `/bin/bash`.
  shell?: string
  // Hard ceiling on the probe so a wedged rc file can't hang boot.
  timeoutMs?: number
  // Injectable for tests so they don't spawn a real shell.
  run?: ShellProbe
}

// Map of vars actually back-filled (var → value). Empty when nothing changed.
export function hydrateAgentConfigEnvFromShell(opts: HydrateAgentConfigEnvOptions = {}): Record<string, string> {
  const env = opts.env ?? process.env
  // Only probe for vars the launching env doesn't already carry — the common
  // case (user exported the var and ran `canary-lab ui` from that same shell)
  // needs no shell at all.
  const missing = AGENT_CONFIG_VARS.filter((v) => !env[v]?.trim())
  if (missing.length === 0) return {}

  const shell = opts.shell ?? env.SHELL ?? '/bin/bash'
  const run = opts.run ?? defaultProbe
  // `-i -c` so the rc file is sourced, matching how the PTY heal agent is
  // spawned. Markers fence our output so rc-file chatter on stdout can't be
  // mistaken for a value; each var is emitted as `KEY=value` between them.
  const script = [
    `printf '%s\\n' '${MARKER_START}'`,
    ...missing.map((v) => `printf '%s=%s\\n' '${v}' "$${v}"`),
    `printf '%s\\n' '${MARKER_END}'`,
  ].join('; ')

  const out = run(shell, ['-i', '-c', script], opts.timeoutMs ?? 4000)
  if (out === null) return {}

  const parsed = parseFencedEnv(out)
  const hydrated: Record<string, string> = {}
  for (const v of missing) {
    const value = parsed[v]?.trim()
    if (value) {
      env[v] = value
      hydrated[v] = value
    }
  }
  return hydrated
}

// Extract `KEY=value` lines that fall strictly between the markers.
function parseFencedEnv(out: string): Record<string, string> {
  const lines = out.split('\n')
  const start = lines.indexOf(MARKER_START)
  const end = lines.indexOf(MARKER_END)
  if (start < 0 || end < 0 || end <= start) return {}
  const result: Record<string, string> = {}
  for (const line of lines.slice(start + 1, end)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    result[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return result
}

function defaultProbe(shell: string, args: string[], timeoutMs: number): string | null {
  try {
    const res = spawnSync(shell, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (res.status !== 0 || typeof res.stdout !== 'string') return null
    return res.stdout
  } catch {
    return null
  }
}
