import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

// One home for resolving an agent CLI (`claude` / `codex`) to an absolute path.
// Lives next to `agent-process.ts` (the spawn primitive) so the runner can
// resolve a bare agent name itself — no spawn site has to remember to call
// `resolveAgentBinary` before handing the runner a command. `auto-heal.ts`
// re-exports these for the orchestrator's REPL command builder. See the
// `cl_reuse-shared-logic` skill.

export type HealAgent = 'claude' | 'codex'

export function isAgentKind(command: string): command is HealAgent {
  return command === 'claude' || command === 'codex'
}

// Injectable seams for agent-binary resolution. Production uses real `which`
// + fs probing; tests inject deterministic stubs.
export interface AgentResolveDeps {
  which?: (agent: string) => string | null
  isExecutable?: (filePath: string) => boolean
  env?: NodeJS.ProcessEnv
  homedir?: () => string
}

function defaultWhich(agent: string): string | null {
  try {
    // `which` exits non-zero (→ throws) when nothing is found, so a clean
    // return always carries a path. An empty result is treated as not-found
    // by the caller (falsy), so no extra guard is needed here.
    const out = execFileSync('which', [agent], { encoding: 'utf-8' }).trim()
    return out.split('\n')[0].trim()
  } catch {
    return null
  }
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// nvm installs CLIs under ~/.nvm/versions/node/<ver>/bin. Best-effort scan so
// a Node-installed `codex`/`claude` is found even when the active nvm version
// isn't on the server's PATH.
function nodeVersionBinDirs(homedir: string): string[] {
  const base = path.join(homedir, '.nvm', 'versions', 'node')
  try {
    return fs.readdirSync(base).map((ver) => path.join(base, ver, 'bin'))
  } catch {
    return []
  }
}

// Well-known install locations probed when the agent isn't on the server's
// PATH. This is the crux of the restricted-PATH fix: when the UI server is
// launched by a GUI client (e.g. Claude Desktop) its PATH is minimal and omits
// ~/.local/bin etc., so a bare `which claude` fails even though claude is
// installed. We probe the usual homes so local auto-heal still spawns.
export function candidateAgentPaths(
  agent: HealAgent,
  homedir: string,
): string[] {
  const dirs = [
    path.join(homedir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(homedir, '.npm-global', 'bin'),
    path.join(homedir, 'Library', 'pnpm'),
    ...nodeVersionBinDirs(homedir),
  ]
  return dirs.map((dir) => path.join(dir, agent))
}

// Resolve the absolute path of an agent CLI, or null when not found.
// Order: explicit env override → PATH (`which`) → well-known locations.
export function resolveAgentBinary(agent: HealAgent, deps: AgentResolveDeps = {}): string | null {
  const which = deps.which ?? defaultWhich
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const env = deps.env ?? process.env
  const homedir = deps.homedir ? deps.homedir() : os.homedir()

  const override = agent === 'claude' ? env.CANARY_LAB_CLAUDE_BIN : env.CANARY_LAB_CODEX_BIN
  if (override && isExecutable(override)) return override

  const onPath = which(agent)
  if (onPath) return onPath

  for (const candidate of candidateAgentPaths(agent, homedir)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function isAgentCliAvailable(agent: HealAgent, deps: AgentResolveDeps = {}): boolean {
  return resolveAgentBinary(agent, deps) !== null
}
