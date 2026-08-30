// How a run reaches the outside world: the Playwright command it invokes, the
// placeholder agent command tests fall back to, and the signal handling that
// makes sure nothing the run started outlives it.
//
// Split out of orchestrator.ts. Stays in logic/runtime/ deliberately —
// SUMMARY_REPORTER_PATH resolves a sibling file via __dirname, so moving this
// module to another directory would silently point the reporter at nothing.

import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { PtyHandle } from './pty-spawner'
import type { RunPaths } from './run-paths'
import type { PlaywrightRerunSelection } from './run-verdict'
import { canSignalProcessGroup, signalProcessTree } from '../../../../shared/process-tree'

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
export const defaultPlaywrightSpawner: PlaywrightSpawner = ({ feature, paths, rerunTargets, rerunGrep, rerunSelection }) => {
  const reporter = SUMMARY_REPORTER_PATH
  const threshold = feature.healOnFailureThreshold
  const maxFailures = typeof threshold === 'number' && threshold > 0
    ? ` --max-failures=${threshold}`
    : ''
  const targets = rerunTargets && rerunTargets.length > 0
    ? ` ${rerunTargets.map((target) => JSON.stringify(target)).join(' ')}`
    : ''
  const grep = rerunGrep ? ` --grep=${JSON.stringify(rerunGrep)}` : ''
  const testList = writeRerunTestList(paths.rerunListPath, rerunSelection)
    ? ` --test-list=${JSON.stringify(paths.rerunListPath)}`
    : ''
  return {
    command: `npx playwright test${targets}${grep}${testList} --output=${JSON.stringify(paths.playwrightArtifactsDir)} --reporter=${JSON.stringify(reporter)},list${maxFailures}`,
    cwd: feature.featureDir,
  }
}

/**
 * Write the `--test-list` file for a targeted rerun. Returns false when the
 * selection is not a test list, so the caller omits the flag.
 *
 * Each line is the test as Playwright's own `--list` renders it, captured by the
 * summary reporter at inventory time. Nothing here derives or rewrites a path:
 * a wrong path prefix, or a project name written without its `[brackets]`,
 * matches zero tests and Playwright reports that as an ordinary empty run rather
 * than an error — which would leave the run's verdict resting on a rerun that
 * executed nothing.
 */
export function writeRerunTestList(
  listPath: string,
  selection?: PlaywrightRerunSelection,
): boolean {
  if (selection?.kind !== 'test-list' || selection.testList.length === 0) return false
  fs.mkdirSync(path.dirname(listPath), { recursive: true })
  fs.writeFileSync(listPath, selection.testList.join('\n') + '\n')
  return true
}

// A pgid this process may legitimately blast. node-pty always reports a real
// child pid (> 1), so anything else can only come from a stale or fabricated
// handle — and negating it turns the group kill into a broadcast: kill(-1)
// signals EVERY process the user may signal (it has logged this machine out),
// kill(-0)/kill(0) our own process group, and pid 1 is launchd. Refusing here
// is a correctness rule, not test convenience: no such pid ever names the
// run's children, so the per-pty fallback is the only honest thing left.
// Send `signal` to the entire process group of `pty`. node-pty spawns its
// child in a fresh session, so the pty's pid is the pgid — `process.kill(-pid, ...)`
// hits the shell AND its pipeline children (claude, formatter). Falls back to
// the pty's own kill (which only signals the shell) if the pid can't name a
// child process group or pgkill fails — better than nothing.
export function killTree(pty: PtyHandle, signal: NodeJS.Signals | number): void {
  signalProcessTree(pty, signal, { detachedProcessGroup: true })
}

// SIGTERM gives the agent time to flush. If it's still alive 2s later, SIGKILL
// the group so a wedged child doesn't outlive the run. Same pgid guard as
// killTree — this timer outlives any per-test process.kill mock, so a bogus
// pid here must stay inert forever, not just while a suite's spies are up.
export function scheduleSigkillFallback(pty: PtyHandle, ms = 2000): void {
  setTimeout(() => {
    if (canSignalProcessGroup(pty.pid)) {
      try { process.kill(-pty.pid, 'SIGKILL') } catch { /* already dead */ }
    } else {
      try { pty.kill('SIGKILL') } catch { /* already dead */ }
    }
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
