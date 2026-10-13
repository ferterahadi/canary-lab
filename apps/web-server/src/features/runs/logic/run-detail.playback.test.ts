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

it('delivers each stamped attempt its own retained media and lists what no attempt claims', () => {
  const logs = temp()
  const dir = runDirFor(logs, 'stamped')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'stamped', feature: 'page', status: 'failed', services: [] }))
  const shot = path.join(dir, 'playwright-artifacts', 'a-chromium', 'test-failed-1.png')
  const test = { name: 'renders', title: 'renders', location: 'page.spec.ts:1' }
  const events = [
    { type: 'test-begin', time: '1', test, execution: 1 },
    { type: 'test-end', time: '2', test, status: 'failed', passed: false, durationMs: 1, retry: 0, execution: 1, attachments: [{ name: 'screenshot', path: shot }] },
  ]
  fs.writeFileSync(path.join(dir, 'playwright-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'))
  for (const rel of ['execution-1/a-chromium/test-failed-1.png', 'execution-1/stray/trace.zip']) {
    fs.mkdirSync(path.dirname(path.join(dir, 'playwright-artifacts-history', rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, 'playwright-artifacts-history', rel), 'x')
  }

  const detail = getRunDetail(logs, 'stamped')!
  const attemptKey = detail.playbackIdentity!.eventKeys[0]!.attemptKey
  expect(detail.attemptArtifacts?.[attemptKey]?.map((a) => a.path)).toEqual(['execution-1/a-chromium/test-failed-1.png'])
  expect(detail.unassignedArtifacts?.map((a) => [a.execution, a.path])).toEqual([[1, 'execution-1/stray/trace.zip']])
})
