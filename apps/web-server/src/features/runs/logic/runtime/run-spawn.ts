// How a run reaches the outside world: the Playwright command it invokes, the
// placeholder agent command tests fall back to, and the signal handling that
// makes sure nothing the run started outlives it.
//
// Split out of orchestrator.ts. Stays in logic/runtime/ deliberately —
// SUMMARY_REPORTER_PATH resolves a sibling file via __dirname, so moving this
// module to another directory would silently point the reporter at nothing.

import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { PtyHandle } from './pty-spawner'
import type { RunPaths } from './run-paths'
import type { PlaywrightRerunSelection } from './run-verdict'

export interface PlaywrightInvocation {
  command: string
  cwd: string
}

export type PlaywrightSpawner = (args: {
  feature: FeatureConfig
  paths: RunPaths
  rerunTargets?: readonly string[]
  rerunGrep?: string
  rerunSelection?: PlaywrightRerunSelection
}) => PlaywrightInvocation

const SUMMARY_REPORTER_PATH = path.resolve(__dirname, 'summary-reporter.js')

// Bracketed-paste sequences. Modern TUIs (claude REPL included) toggle
// `\x1b[?2004h` on init to opt into "this is a paste" framing — text
// between the markers is inserted into the input field as a single block
// instead of being processed by the line editor character-by-character.
// Without these wrappers, every word the orchestrator writes via
// `pty.write` shows up in the transcript as `<word>\x1b[1C<word>...`,
// producing messy output and ballooning the log size.
export const BRACKETED_PASTE_BEGIN = '\x1b[200~'
export const BRACKETED_PASTE_END = '\x1b[201~'

// Production Playwright invocation. Uses `npx playwright test` with our custom
// summary reporter, rooted at the feature dir. Tests inject their own.
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths, rerunTargets, rerunGrep }) => {
  const reporter = SUMMARY_REPORTER_PATH
  const threshold = feature.healOnFailureThreshold
  const maxFailures = typeof threshold === 'number' && threshold > 0
    ? ` --max-failures=${threshold}`
    : ''
  const targets = rerunTargets && rerunTargets.length > 0
    ? ` ${rerunTargets.map((target) => JSON.stringify(target)).join(' ')}`
    : ''
  const grep = rerunGrep ? ` --grep=${JSON.stringify(rerunGrep)}` : ''
  return {
    command: `npx playwright test${targets}${grep} --output=${JSON.stringify(paths.playwrightArtifactsDir)} --reporter=${JSON.stringify(reporter)},list${maxFailures}`,
    cwd: feature.featureDir,
  }
}

// Send `signal` to the entire process group of `pty`. node-pty spawns its
// child in a fresh session, so the pty's pid is the pgid — `process.kill(-pid, ...)`
// hits the shell AND its pipeline children (claude, formatter). Falls back to
// the pty's own kill (which only signals the shell) if pgkill fails — better
// than nothing.
export function killTree(pty: PtyHandle, signal: NodeJS.Signals | number): void {
  try {
    process.kill(-pty.pid, signal)
    return
  } catch { /* fall through */ }
  try { pty.kill(typeof signal === 'string' ? signal : undefined) } catch { /* already dead */ }
}

// SIGTERM gives the agent time to flush. If it's still alive 2s later, SIGKILL
// the group so a wedged child doesn't outlive the run.
export function scheduleSigkillFallback(pty: PtyHandle, ms = 2000): void {
  setTimeout(() => {
    try { process.kill(-pty.pid, 'SIGKILL') } catch { /* already dead */ }
  }, ms).unref?.()
}

// Production wires `buildAgentSpawnCommand` / `buildOrchestratorHealPrompt`
// from auto-heal.ts; these defaults are intentionally minimal so unit tests
// never silently run a real claude/codex REPL when an override is missing.
export function defaultSpawnCommand(_args: {
  sessionId?: string
  resume?: boolean
  mcpOutputDir?: string
  promptFile?: string
}): string {
  // A `cat` keeps the pty alive (so the orchestrator can write prompts to
  // its stdin and pty.onExit doesn't fire mid-loop) and echoes everything we
  // type, which is enough for assertions about prompt content in tests.
  return 'cat'
}
