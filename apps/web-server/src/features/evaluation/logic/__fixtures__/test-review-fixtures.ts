import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import ts from 'typescript'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../../runs/logic/run-store'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'

export function coverageLedgerFor(testTitle: string): CoverageLedger {
  return {
    feature: 'checkout',
    requirements: [
      { requirement: { id: 'R1', title: 'Checkout', text: 'x', pathTypes: ['happy'] }, annotatedTestNames: [testTitle], pathCoverage: [{ path: 'happy', covered: true }], gapType: 'covered', coverageStatus: 'covered' },
    ],
    tests: [{ name: testTitle, requirements: ['R1'], pathTypes: ['happy'], strength: 'solid' }],
    totals: { total: 1, covered: 1, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
    coveragePct: 100,
    mappedPct: 100,
    orphanRequirementIds: [],
    orphanTestNames: [],
  }
}

export function detail(opts: {
  featureDir: string
  feature?: string
  eventLocation?: string
  title?: string
  durationMs?: number
  passedNames?: string[]
}): RunDetail {
  const title = opts.title ?? 'passes checkout'
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1',
      feature: opts.feature ?? 'checkout',
      featureDir: opts.featureDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    },
    summary: { complete: true, total: 1, passed: 1, passedNames: opts.passedNames ?? [slugFromTitle(title)], failed: [] },
    playbackEvents: [
      {
        type: 'test-end',
        time: '2026-01-01T00:00:05.000Z',
        test: {
          name: slugFromTitle(title),
          title,
          location: opts.eventLocation ?? path.join(opts.featureDir, 'missing.spec.ts:1'),
        },
        status: 'passed',
        passed: true,
        durationMs: opts.durationMs ?? 5000,
        retry: 0,
      },
    ],
  }
}

// `detail()` always sets a `test-end` playback event, but `RunDetail.playbackEvents`
// is optional and `PlaywrightPlaybackEvent` is a discriminated union — fixtures that
// read/mutate `.status`/`.passed`/`.durationMs`/`.test.location` (fields only present
// on the `test-end` variant) need the array + element narrowed at the call site.
export function testEndEvent(detail: RunDetail, index = 0): Extract<PlaywrightPlaybackEvent, { type: 'test-end' }> {
  const event = detail.playbackEvents?.[index]
  if (!event) throw new Error(`expected detail.playbackEvents[${index}] to be set`)
  if (event.type !== 'test-end') throw new Error(`expected a test-end event at index ${index}, got "${event.type}"`)
  return event
}

export function lineOf(source: string, needle: string): number {
  const idx = source.indexOf(needle)
  expect(idx).toBeGreaterThanOrEqual(0)
  return source.slice(0, idx).split('\n').length
}

export function slugFromTitle(title: string): string {
  return `test-case-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}
