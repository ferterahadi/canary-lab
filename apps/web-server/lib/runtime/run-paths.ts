import path from 'path'

// Per-run directory layout. All paths are derived from a single `runDir`
// (e.g. `<repo>/logs/runs/2026-04-28T1015-abc1`) so the orchestrator can
// remain decoupled from the global LOGS_DIR — useful both for tests and for
// future multi-run-in-flight scenarios.

export interface RunPaths {
  runDir: string
  manifestPath: string
  summaryPath: string
  playwrightStdoutPath: string
  playwrightEventsPath: string
  lifecycleEventsPath: string
  playwrightArtifactsDir: string
  // Durable copy of each Playwright per-test artifact directory. Playwright's
  // `--output=playwright-artifacts/` clears that directory at the start of
  // every invocation, so heal-cycle reruns (which respawn Playwright with
  // `--grep` to retry just the failed test) wipe the videos/traces/screenshots
  // of previously passing tests. After every Playwright invocation the
  // orchestrator copies each per-test subdir from `playwright-artifacts/` into
  // this keep dir; new artifacts for the same pw-slug overwrite the previous
  // copy so the keep dir always reflects the latest attempt per test.
  playwrightArtifactsKeepDir: string
  agentSessionIdPath: string
  // Small JSON pointer that records which agent ran and where its CLI-native
  // JSONL session log is on disk (e.g. ~/.claude/projects/.../<uuid>.jsonl
  // or ~/.codex/sessions/YYYY/MM/DD/<rollout>.jsonl). The structured-view
  // historical replay reads from that JSONL — the agent CLI's own format is
  // far more reliable than our PTY byte capture.
  agentSessionRefPath: string
  runnerLogPath: string
  healIndexPath: string
  diagnosisJournalPath: string
  failedDir: string
  signalsDir: string
  restartSignal: string
  rerunSignal: string
  healSignal: string
  serviceLog(safeName: string): string
}

export function buildRunPaths(runDir: string): RunPaths {
  const signalsDir = path.join(runDir, 'signals')
  return {
    runDir,
    manifestPath: path.join(runDir, 'manifest.json'),
    summaryPath: path.join(runDir, 'e2e-summary.json'),
    playwrightStdoutPath: path.join(runDir, 'playwright.log'),
    playwrightEventsPath: path.join(runDir, 'playwright-events.jsonl'),
    lifecycleEventsPath: path.join(runDir, 'lifecycle-events.jsonl'),
    playwrightArtifactsDir: path.join(runDir, 'playwright-artifacts'),
    playwrightArtifactsKeepDir: path.join(runDir, 'playwright-artifacts-keep'),
    agentSessionIdPath: path.join(runDir, 'agent-session-id.txt'),
    agentSessionRefPath: path.join(runDir, 'agent-session.json'),
    runnerLogPath: path.join(runDir, 'runner.log'),
    healIndexPath: path.join(runDir, 'heal-index.md'),
    diagnosisJournalPath: path.join(runDir, 'diagnosis-journal.md'),
    failedDir: path.join(runDir, 'failed'),
    signalsDir,
    restartSignal: path.join(signalsDir, '.restart'),
    rerunSignal: path.join(signalsDir, '.rerun'),
    healSignal: path.join(signalsDir, '.heal'),
    serviceLog: (safeName: string) => path.join(runDir, `svc-${safeName}.log`),
  }
}

// Resolve the runs root + index for a given logs dir. Kept here so callers
// don't need to memorize the layout convention.
export function runsRoot(logsDir: string): string {
  return path.join(logsDir, 'runs')
}

export function runsIndexPath(logsDir: string): string {
  return path.join(runsRoot(logsDir), 'index.json')
}

export function runDirFor(logsDir: string, runId: string): string {
  return path.join(runsRoot(logsDir), runId)
}

export function currentRunSymlinkPath(logsDir: string): string {
  return path.join(logsDir, 'current')
}
