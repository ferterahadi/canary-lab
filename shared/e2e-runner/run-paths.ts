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
  agentTranscriptPath: string
  healIndexPath: string
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
    agentTranscriptPath: path.join(runDir, 'agent-transcript.log'),
    healIndexPath: path.join(runDir, 'heal-index.md'),
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
