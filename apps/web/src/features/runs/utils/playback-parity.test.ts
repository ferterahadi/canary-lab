import { expect, it } from 'vitest'
import { buildPlaybackIdentity } from '@shared/playback-identity'
import type { RunDetail, PlaywrightPlaybackEvent } from '@shared/run-detail'
import { playbackTests } from './run-detail-playback'
import { declaredRoster, playbackTests as reportAttempts } from '../../../../../web-server/src/features/evaluation/logic/test-review/packet'

it.each([true, false])('keeps UI and report outcomes aligned with duplicate names (declared=%s)', (declared) => {
  const known = [10, 20].map((line) => ({ name: 'renders', title: 'renders', location: `page.spec.ts:${line}` }))
  const events: PlaywrightPlaybackEvent[] = known.map((test, index) => ({ type: 'test-end', test, time: String(index), status: index ? 'passed' : 'failed', passed: !!index, retry: 0, durationMs: 1 }))
  const roster = declared ? known : []
  const detail = { summary: { knownTests: roster } } as RunDetail
  const ui = playbackTests(events, buildPlaybackIdentity(events, roster)).map((test) => [test.location, test.status])
  const report = declaredRoster(detail, reportAttempts(events), new Map()).map(({ entry, attempt }) => [entry.location, attempt?.status])
  expect(ui).toEqual([['page.spec.ts:10', 'failed'], ['page.spec.ts:20', 'passed']])
  expect(ui).toEqual(report)
})

it('keeps the recorded line-shift regression aligned across UI and report', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const fixture = path.resolve(__dirname, '../../../../../web-server/src/features/evaluation/logic/__fixtures__/heal-line-shift')
  const summary = JSON.parse(fs.readFileSync(path.join(fixture, 'e2e-summary.json'), 'utf8'))
  const events = JSON.parse(fs.readFileSync(path.join(fixture, 'playwright-events.json'), 'utf8'))
  const projection = buildPlaybackIdentity(events, summary.knownTests)
  const ui = playbackTests(events, projection).map((test) => [test.name, test.status])
  const report = declaredRoster({ summary } as RunDetail, reportAttempts(events, projection), new Map()).map(({ entry, attempt }) => [entry.name, attempt?.status])
  expect(ui).toEqual(report)
  expect(ui).toHaveLength(3)
  expect(ui.every((test) => test[1] === 'passed')).toBe(true)
})

const recorded = (file: string, line: number, id?: string) => ({ name: 'renders', title: 'renders', location: `${file}:${line}`, ...(id ? { id } : {}) })
const completed = (test: ReturnType<typeof recorded>, time: string, passed = true): PlaywrightPlaybackEvent => ({ type: 'test-end', test, time, status: passed ? 'passed' : 'failed', passed, retry: 0, durationMs: 1 })

it.each([
  { label: 'different files', known: [], events: [completed(recorded('a.spec.ts', 1), '1', false), completed(recorded('b.spec.ts', 1), '2')], statuses: ['failed', 'passed'] },
  { label: 'retry returns to original line', known: [recorded('a.spec.ts', 1)], events: [completed(recorded('a.spec.ts', 1), '1', false), completed(recorded('a.spec.ts', 8), '2', false), completed(recorded('a.spec.ts', 1), '3')], statuses: ['passed'] },
  { label: 'end timestamp beats event arrival', known: [recorded('a.spec.ts', 1)], events: [completed(recorded('a.spec.ts', 8), '3'), completed(recorded('a.spec.ts', 1), '2', false)], statuses: ['passed'] },
  { label: 'missing source preserves locations', known: [], events: [completed(recorded('missing.spec.ts', 1), '1', false), completed(recorded('missing.spec.ts', 8), '2')], statuses: ['failed', 'passed'] },
])('shares completed attempt reconciliation: $label', ({ known, events, statuses }) => {
  const projection = buildPlaybackIdentity(events, known)
  const ui = playbackTests(events, projection)
  const report = declaredRoster({ summary: { knownTests: known } } as RunDetail, reportAttempts(events, projection), new Map())
  expect(ui.map((test) => test.status)).toEqual(statuses)
  expect(report.map((test) => test.attempt?.status)).toEqual(statuses)
  expect(ui.map((test) => test.location)).toEqual(report.map((test) => test.attempt?.location))
})

it('keeps concurrent steps separate and a later attempt live without losing never-run report entries', () => {
  const known = [recorded('a.spec.ts', 1, 'one'), recorded('a.spec.ts', 8, 'two'), recorded('a.spec.ts', 12, 'never')]
  const events: PlaywrightPlaybackEvent[] = [
    completed(known[0], '1'),
    { type: 'test-begin', test: known[0], time: '2' },
    { type: 'test-begin', test: known[1], time: '3' },
    { type: 'step-begin', test: known[0], time: '4', step: { title: 'page.click', category: 'test.step' } },
    { type: 'step-begin', test: known[1], time: '5', step: { title: 'page.goto', category: 'test.step' } },
    { type: 'step-begin', test: { name: 'renders', title: 'renders' }, time: '6', step: { title: 'ambiguous', category: 'pw:api' } },
  ]
  const projection = buildPlaybackIdentity(events, known)
  const ui = playbackTests(events, projection)
  expect(ui.map((test) => test.status)).toEqual([undefined, undefined])
  expect(ui.map((test) => test.steps.map((step) => step.title))).toEqual([['Clicked page element'], ['Opened page']])
  expect(projection.eventKeys[5]).toBeNull()
  const report = declaredRoster({ summary: { knownTests: known } } as RunDetail, reportAttempts(events, projection), new Map())
  expect(report.map((test) => test.entry.location)).toEqual(known.map((test) => test.location))
  expect(report[2].attempt).toBeUndefined()
})
