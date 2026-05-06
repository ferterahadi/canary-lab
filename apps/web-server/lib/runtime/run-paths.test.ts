import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  buildRunPaths,
  currentRunSymlinkPath,
  runDirFor,
  runsIndexPath,
  runsRoot,
} from './run-paths'

describe('buildRunPaths', () => {
  const runDir = '/tmp/proj/logs/runs/2026-04-28T1015-abc1'
  const p = buildRunPaths(runDir)

  it('exposes runDir verbatim', () => {
    expect(p.runDir).toBe(runDir)
  })

  it('places manifest, summary, logs at runDir root', () => {
    expect(p.manifestPath).toBe(path.join(runDir, 'manifest.json'))
    expect(p.summaryPath).toBe(path.join(runDir, 'e2e-summary.json'))
    expect(p.playwrightStdoutPath).toBe(path.join(runDir, 'playwright.log'))
    expect(p.playwrightEventsPath).toBe(path.join(runDir, 'playwright-events.jsonl'))
    expect(p.playwrightArtifactsDir).toBe(path.join(runDir, 'playwright-artifacts'))
    expect(p.agentTranscriptPath).toBe(path.join(runDir, 'agent-transcript.log'))
    expect(p.runnerLogPath).toBe(path.join(runDir, 'runner.log'))
    expect(p.healIndexPath).toBe(path.join(runDir, 'heal-index.md'))
    expect(p.diagnosisJournalPath).toBe(path.join(runDir, 'diagnosis-journal.md'))
    expect(p.failedDir).toBe(path.join(runDir, 'failed'))
  })

  it('places signals under signals/', () => {
    expect(p.signalsDir).toBe(path.join(runDir, 'signals'))
    expect(p.restartSignal).toBe(path.join(runDir, 'signals', '.restart'))
    expect(p.rerunSignal).toBe(path.join(runDir, 'signals', '.rerun'))
    expect(p.healSignal).toBe(path.join(runDir, 'signals', '.heal'))
  })

  it('serviceLog joins safeName under runDir', () => {
    expect(p.serviceLog('api')).toBe(path.join(runDir, 'svc-api.log'))
  })
})

describe('runs root helpers', () => {
  it('runsRoot joins logsDir/runs', () => {
    expect(runsRoot('/proj/logs')).toBe('/proj/logs/runs')
  })

  it('runsIndexPath places index.json under runs', () => {
    expect(runsIndexPath('/proj/logs')).toBe('/proj/logs/runs/index.json')
  })

  it('runDirFor combines runs root with run id', () => {
    expect(runDirFor('/proj/logs', '2026-04-28T1015-abc1')).toBe(
      '/proj/logs/runs/2026-04-28T1015-abc1',
    )
  })

  it('currentRunSymlinkPath places `current` at logs root', () => {
    expect(currentRunSymlinkPath('/proj/logs')).toBe('/proj/logs/current')
  })
})
