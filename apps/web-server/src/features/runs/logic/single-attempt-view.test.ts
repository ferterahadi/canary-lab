import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { RunIndexEntry } from './runtime/manifest'
import type { RunDetail } from './run-detail'
import { withSingleAttemptDetailState, withSingleAttemptIndexState } from './single-attempt-view'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-single-attempt-view-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('keeps the list and detail in sync when an older run claims its receipt', () => {
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  const featureDir = path.join(featuresDir, 'demo')
  const runDir = path.join(logsDir, 'runs', 'run-1')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'),
    "module.exports = { config: { name: 'demo', singleAttempt: { receipt: 'runtime/attempt.json' } } }\n")
  const manifest = { runId: 'run-1', feature: 'demo', featureDir, startedAt: 'now', status: 'failed', healCycles: 0, services: [] } as const
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
  const entry: RunIndexEntry = { runId: 'run-1', feature: 'demo', startedAt: 'now', status: 'failed' }
  const detail: RunDetail = { runId: 'run-1', manifest }

  expect(withSingleAttemptIndexState([entry], logsDir, featuresDir)[0].newRunRequired).toBeUndefined()
  expect(withSingleAttemptDetailState(detail, logsDir).newRunRequired).toBeUndefined()

  fs.mkdirSync(path.join(runDir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(runDir, 'runtime', 'attempt.json'), '{}')

  expect(withSingleAttemptIndexState([entry], logsDir, featuresDir)[0].newRunRequired).toBe(true)
  expect(withSingleAttemptDetailState(detail, logsDir).newRunRequired).toBe(true)
})

it('uses a run-pinned receipt when the current suite config no longer declares the policy', () => {
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  const featureDir = path.join(featuresDir, 'demo')
  const runDir = path.join(logsDir, 'runs', 'run-2')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(path.join(runDir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'demo' } }\n")
  const manifest = {
    runId: 'run-2', feature: 'demo', featureDir, startedAt: 'now', status: 'failed', healCycles: 0, services: [],
    singleAttempt: { receipt: 'runtime/attempt.json' },
  } as const
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(runDir, 'runtime', 'attempt.json'), '{}')
  const entry: RunIndexEntry = { runId: 'run-2', feature: 'demo', startedAt: 'now', status: 'failed' }
  const detail: RunDetail = { runId: 'run-2', manifest }

  expect(withSingleAttemptIndexState([entry], logsDir, featuresDir)[0].newRunRequired).toBe(true)
  expect(withSingleAttemptDetailState(detail, logsDir).newRunRequired).toBe(true)
})

it('leaves an older run restartable when its suite has no receipt policy', () => {
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  const featureDir = path.join(featuresDir, 'demo')
  const runDir = path.join(logsDir, 'runs', 'run-3')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'demo' } }\n")
  const manifest = { runId: 'run-3', feature: 'demo', featureDir, startedAt: 'now', status: 'failed', healCycles: 0, services: [] } as const
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
  const entry: RunIndexEntry = { runId: 'run-3', feature: 'demo', startedAt: 'now', status: 'failed' }

  expect(withSingleAttemptIndexState([entry, entry], logsDir, featuresDir)).toEqual([entry, entry])
  const alreadyRequired = { ...entry, newRunRequired: true }
  expect(withSingleAttemptIndexState([alreadyRequired], logsDir, featuresDir)).toEqual([alreadyRequired])
  expect(withSingleAttemptDetailState({ runId: 'run-3', manifest }, logsDir).newRunRequired).toBeUndefined()
})
