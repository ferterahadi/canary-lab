import fs from 'fs'
import path from 'path'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import { writeManifest } from '../runtime/manifest'
import { runDirFor } from '../runtime/run-paths'

/** Structural defaults only; each test supplies the evidence it exercises. */
export function runManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1', feature: 'checkout', startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running', healCycles: 0, services: [], ...overrides,
  }
}

type SeededRunStatus = 'running' | 'passed' | 'failed' | 'healing' | 'aborted'

/**
 * Seeds `<logsDir>/<runId>/manifest.json` for a route test. The directories are
 * read through a getter because each suite re-creates them in `beforeEach`.
 */
export function manifestWriterFor(dirs: () => { logsDir: string; featuresDir: string }) {
  return (runId: string, feature = 'foo', status: SeededRunStatus = 'passed'): void => {
    const { logsDir, featuresDir } = dirs()
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature,
      featureDir: path.join(featuresDir, feature),
      startedAt: 'now',
      status,
      healCycles: 0,
      services: [],
    })
  }
}
