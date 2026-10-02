import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FileRunStateSink } from '../../../../../web-server/src/features/runs/logic/runtime/run-state-sink'
import {
  readManifest,
  readRunsIndex,
} from '../../../../../web-server/src/features/runs/logic/runtime/manifest'
import type { RunManifest } from '@shared/run-manifest'
import { runManifest } from '../../../../../web-server/src/features/runs/logic/__fixtures__/run-manifest'
import { initialRunsState, runsReducer } from './runs-state'
import type { RunDetail } from '@shared/run-detail'

let logs: string
beforeEach(() => { logs = fs.mkdtempSync(path.join(os.tmpdir(), 'run-index-parity-')) })
afterEach(() => { fs.rmSync(logs, { recursive: true, force: true }) })
function browserRow(manifest: RunManifest) {
  return runsReducer(initialRunsState, { type: 'update', runId: manifest.runId, detail: { runId: manifest.runId, manifest } as RunDetail }).runs[0]
}

it('keeps a file-backed index identical to browser updates, including cleared review counts', () => {
  const manifest = runManifest({
    status: 'healing', healCycles: 2, healMode: 'external', env: 'staging', executionType: 'verify',
    verification: { configName: 'Staging', playwrightEnvsetId: 'staging', targetUrls: { app: 'https://example.test' }, targets: [] },
    specEdits: { checkedAt: 't', pending: [{ file: 'e2e/sample.spec.ts', change: 'modified', affectedTests: ['sample'] }], adopted: [] },
    integrity: { hints: [{ kind: 'cannot-classify', file: 'e2e/sample.spec.ts', reason: 'changed' }], disclosure: 'review needed' },
  })
  const sink = new FileRunStateSink(logs)
  sink.bootstrap(manifest)
  const expected = {
    runId: manifest.runId, feature: manifest.feature, startedAt: manifest.startedAt, status: 'healing',
    healCycles: 2, healMode: 'external', env: 'staging', executionType: 'verify',
    verificationConfigName: 'Staging', verificationPlaywrightEnvsetId: 'staging',
    verificationTargetUrls: { app: 'https://example.test' }, pendingSpecEdits: 1, integrityHints: 1,
  }
  expect(readRunsIndex(logs)[0]).toEqual(expected)
  expect(browserRow(manifest)).toEqual(expected)
  sink.patchManifest(manifest.runId, { specEdits: { checkedAt: 't2', pending: [], adopted: [] }, integrity: { hints: [], disclosure: '' } })
  sink.finalize(manifest.runId, 'passed', '2026-01-01T00:01:00.000Z', 2)
  const stored = readManifest(sink.manifestPath(manifest.runId))!
  const disk = readRunsIndex(logs)[0]
  expect(disk).not.toHaveProperty('pendingSpecEdits')
  expect(disk).not.toHaveProperty('integrityHints')
  expect(disk.endedAt).toBe('2026-01-01T00:01:00.000Z')
  expect(browserRow(stored)).toEqual(disk)
})

it('preserves legacy omissions and zero-value projection', () => {
  const manifest = runManifest()
  const sink = new FileRunStateSink(logs)
  sink.bootstrap(manifest)
  const expected = { runId: manifest.runId, feature: manifest.feature, startedAt: manifest.startedAt, status: 'running' }
  expect(readRunsIndex(logs)[0]).toEqual(expected)
  expect(browserRow(manifest)).toEqual(expected)
  const { healCycles: _cycles, ...legacy } = manifest
  expect(browserRow(legacy as RunManifest)).toEqual(expected)
})
