import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import * as source from '../../../shared/playback-source-declarations'
import { getRunDetail } from './run-detail'
import { runDirFor } from './runtime/run-paths'

const temp = trackTempDirs('run-playback-')
afterEach(() => vi.restoreAllMocks())
it.each([true, false])('projects the exact events and reads source only without a roster (known=%s)', (known) => {
  const logs = temp()
  const dir = runDirFor(logs, 'record')
  const suite = temp()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(suite, 'page.spec.ts')
  fs.writeFileSync(file, "test('renders', () => {})")
  const test = { name: 'renders', title: 'renders', location: `${file}:1` }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'record', feature: 'page', featureDir: suite, status: 'failed', services: [] }))
  fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify({ complete: true, passed: 0, total: 1, failed: [], knownTests: known ? [test] : [] }))
  const events = [1, 3].map((line) => ({ type: 'test-end', test: { ...test, location: `${file}:${line}` }, time: String(line), status: 'failed', passed: false, durationMs: 1, retry: 0 }))
  const raw = events.map((event) => JSON.stringify(event)).join('\n')
  const eventPath = path.join(dir, 'playwright-events.jsonl')
  fs.writeFileSync(eventPath, raw)
  const spy = vi.spyOn(source, 'readPlaybackSourceDeclarations')
  const detail = getRunDetail(logs, 'record')!
  expect(detail.playbackEvents).toEqual(events)
  expect(new Set(detail.playbackIdentity?.eventKeys.map((entry) => entry?.caseKey)).size).toBe(1)
  expect(spy).toHaveBeenCalledTimes(known ? 0 : 1)
  expect(fs.readFileSync(eventPath, 'utf8')).toBe(raw)
  expect(detail.summary?.passed).toBe(0)
})
