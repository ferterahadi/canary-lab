// Folder trust for the `claude` CLI — the gate that silently blocks an
// unattended repair.
//
// Claude Code asks "Is this a project you created or one you trust?" the first
// time it opens a directory interactively. Measured on claude 2.1.241:
//
//   - The answer is stored as `projects["<abs path>"].hasTrustDialogAccepted`
//     in the CLI's global config JSON.
//   - Trust is checked for the exact interactive cwd. A trusted project root
//     does not cover a fresh `<project>/logs/runs/<id>` directory.
//   - The prompt only appears on an interactive TTY. `claude -p` skips it
//     entirely (its own `--help` says so), which is why every headless agent
//     canary spawns has always been fine.
//
// Canary's heal agent is the one spawn that is BOTH interactive (a pty, so the
// user can interject) and unattended (autopilot). Its cwd is
// `<projectRoot>/logs/runs/<runId>` — new every run. So on a workspace whose
// root has never been trusted, every run hits the prompt, nobody answers, and
// the cycle burns its full idle window before reporting "no code changes were
// made" — which reads as "the agent tried and failed" when it never started.
//
// Granting trust for the exact RUN DIRECTORY before the spawn fixes that run
// and is narrower than trusting the whole project. It is NOT a permission
// bypass — the REPL still asks before each tool call.

import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Absolute path to the `claude` CLI's global config JSON.
 *
 * Default is `~/.claude.json` — a sibling of `~/.claude`, not a file inside
 * it. With `CLAUDE_CONFIG_DIR` set, the CLI keeps the same basename inside
 * that directory. Resolved from `process.env` for the same reason
 * `claudeConfigDir` is (see agent-session-paths.ts): the process that reads it
 * is the process that spawns the agent, so the two always agree.
 */
export function claudeGlobalConfigFile(homeDir: string = os.homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return path.join(override ? override : homeDir, '.claude.json')
}

export type TrustOutcome =
  /** The exact directory was already trusted — no write. */
  | 'already-trusted'
  /** We added the entry; the next interactive claude here won't prompt. */
  | 'granted'
  /** Config missing, unreadable, unwritable, or the target is too broad. */
  | 'unavailable'

export interface TrustResult {
  outcome: TrustOutcome
  /** The exact trusted path we found or wrote. */
  trustedPath?: string
  /** Why an `unavailable` outcome happened, for the run transcript. */
  reason?: string
}

interface ClaudeConfigShape {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>>
}

// Refuse to claim trust over a directory that isn't specifically a workspace.
// `/` and the user's home cover every repo they own, so a stray call must not
// be able to silence the prompt everywhere.
function isTooBroad(dir: string, homeDir: string): boolean {
  return dir === path.parse(dir).root || dir === realpathOrSelf(homeDir)
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

function readConfig(file: string): ClaudeConfigShape | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as ClaudeConfigShape) : null
  } catch {
    return null
  }
}

/**
 * Is this exact directory already trusted by Claude Code? Claude resolves
 * symlinks before keying the config, so match against the real path.
 */
export function claudeTrustedPath(
  dir: string,
  opts: { configFile?: string; homeDir?: string } = {},
): string | null {
  const homeDir = opts.homeDir ?? os.homedir()
  const file = opts.configFile ?? claudeGlobalConfigFile(homeDir)
  const config = readConfig(file)
  const projects = config?.projects
  if (!projects) return null
  const exact = realpathOrSelf(dir)
  return projects[exact]?.hasTrustDialogAccepted === true ? exact : null
}

/**
 * Make sure an interactive `claude` started in `workspaceRoot` opens without
 * the folder-trust prompt.
 *
 * No-ops when that exact path is already trusted. Otherwise adds
 * `hasTrustDialogAccepted: true` for `workspaceRoot` alone, preserving every
 * other key in the file, via a same-directory temp file + rename so a crash
 * mid-write can't truncate the user's config.
 *
 * Best-effort by design: a missing config file means the CLI has never run
 * (nothing to merge into, and inventing one risks disturbing its onboarding),
 * so we report `unavailable` and let the caller say so rather than guess.
 */
export function ensureClaudeWorkspaceTrusted(
  workspaceRoot: string,
  opts: { configFile?: string; homeDir?: string } = {},
): TrustResult {
  const homeDir = opts.homeDir ?? os.homedir()
  const file = opts.configFile ?? claudeGlobalConfigFile(homeDir)
  const root = realpathOrSelf(workspaceRoot)

  if (isTooBroad(root, homeDir)) {
    return { outcome: 'unavailable', reason: `refusing to trust ${root} — too broad to claim on the user's behalf` }
  }

  const trusted = claudeTrustedPath(root, { configFile: file, homeDir })
  if (trusted) return { outcome: 'already-trusted', trustedPath: trusted }

  const config = readConfig(file)
  if (!config) {
    return { outcome: 'unavailable', reason: `${file} is missing or unreadable` }
  }

  const projects = { ...(config.projects ?? {}) }
  projects[root] = { ...(projects[root] ?? {}), hasTrustDialogAccepted: true }
  const next = { ...config, projects }

  // Same directory as the target so the rename stays on one filesystem (a
  // rename across devices is not atomic and would fail outright).
  const tmp = `${file}.canary-lab-${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean up */ }
    return { outcome: 'unavailable', reason: `could not update ${file}: ${(err as Error).message}` }
  }
  return { outcome: 'granted', trustedPath: root }
}
