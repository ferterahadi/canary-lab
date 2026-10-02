import type { RunManifest } from '../../../../../../../shared/run-manifest'

/** Structural defaults only; each test supplies the evidence it exercises. */
export function runManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1', feature: 'checkout', startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running', healCycles: 0, services: [], ...overrides,
  }
}
