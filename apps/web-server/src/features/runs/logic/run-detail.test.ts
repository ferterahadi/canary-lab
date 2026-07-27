import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getRunDetail, readRunSummary } from './run-detail'
import { writeManifest } from './runtime/manifest'
import { runDirFor } from './runtime/run-paths'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
})

describe('getRunDetail', () => {
  it('returns null when run dir missing', () => {
    expect(getRunDetail(tmpDir, 'nonsuch')).toBeNull()
  })

  it('returns null when manifest unreadable', () => {
    const dir = runDirFor(tmpDir, 'corrupt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json')
    expect(getRunDetail(tmpDir, 'corrupt')).toBeNull()
  })

  it('reads a valid manifest', () => {
    const dir = runDirFor(tmpDir, 'r1')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r1',
      feature: 'foo',
      startedAt: 'now',
      status: 'passed',
      healCycles: 0,
      services: [],
    })
    const d = getRunDetail(tmpDir, 'r1')
    expect(d?.runId).toBe('r1')
    expect(d?.manifest.feature).toBe('foo')
    expect(d?.summary).toBeUndefined()
  })

  it('includes summary when e2e-summary.json exists alongside manifest', () => {
    const dir = runDirFor(tmpDir, 'r-sum')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-sum',
      feature: 'foo',
      startedAt: 'now',
      status: 'failed',
      healCycles: 0,
      services: [],
    })
    fs.writeFileSync(
      path.join(dir, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        total: 2,
        passed: 1,
        failed: [{ name: 'test-case-x', error: { message: 'boom' } }],
      }),
    )
    const d = getRunDetail(tmpDir, 'r-sum')
    expect(d?.summary?.complete).toBe(true)
    expect(d?.summary?.failed[0].name).toBe('test-case-x')
  })

  it('includes playback events and grouped Playwright artifacts', () => {
    const dir = runDirFor(tmpDir, 'r-artifacts')
    const artifactsDir = path.join(dir, 'playwright-artifacts', 'visual-checkout')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const screenshot = path.join(artifactsDir, 'test-failed-1.png')
    const trace = path.join(artifactsDir, 'trace.zip')
    fs.writeFileSync(screenshot, 'png')
    fs.writeFileSync(trace, 'zip')
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-artifacts',
      feature: 'foo',
      startedAt: 'now',
      status: 'failed',
      healCycles: 0,
      services: [],
    })
    fs.writeFileSync(
      path.join(dir, 'playwright-events.jsonl'),
      [
        JSON.stringify({ type: 'test-begin', time: 't', test: { name: 'test-case-visual-checkout', title: 'Visual checkout', location: '/x:1' } }),
        JSON.stringify({
          type: 'test-end',
          time: 't',
          test: { name: 'test-case-visual-checkout', title: 'Visual checkout', location: '/x:1' },
          status: 'failed',
          passed: false,
          durationMs: 12,
          retry: 0,
          attachments: [
            { name: 'screenshot', contentType: 'image/png', path: screenshot },
            { name: 'trace', contentType: 'application/zip', path: trace },
          ],
        }),
      ].join('\n') + '\n',
    )

    const d = getRunDetail(tmpDir, 'r-artifacts')
    expect(d?.playbackEvents).toHaveLength(2)
    expect(d?.playwrightArtifacts).toEqual([
      {
        testName: 'test-case-visual-checkout',
        testTitle: 'Visual checkout',
        artifacts: [
          expect.objectContaining({ kind: 'screenshot', path: 'visual-checkout/test-failed-1.png' }),
          expect.objectContaining({ kind: 'trace', path: 'visual-checkout/trace.zip' }),
        ],
      },
    ])
    expect(d?.playwrightArtifacts?.[0].artifacts[0].url).toBe('/api/runs/r-artifacts/artifacts/visual-checkout/test-failed-1.png')
  })
})

describe('readRunSummary', () => {
  it('returns undefined when summary file missing', () => {
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns undefined when summary file is unparseable', () => {
    fs.writeFileSync(path.join(tmpDir, 'e2e-summary.json'), '{not json')
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns undefined when summary parses to a non-object', () => {
    fs.writeFileSync(path.join(tmpDir, 'e2e-summary.json'), 'null')
    expect(readRunSummary(tmpDir)).toBeUndefined()
  })

  it('returns parsed summary on a valid file', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'e2e-summary.json'),
      JSON.stringify({ complete: false, total: 0, passed: 0, failed: [] }),
    )
    expect(readRunSummary(tmpDir)).toEqual({ complete: false, total: 0, passed: 0, failed: [] })
  })

  it('preserves verified-coverage linkage on knownTests entries', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        total: 1,
        passed: 1,
        passedNames: ['login works'],
        passedIds: ['t1'],
        knownTests: [
          {
            id: 't1',
            name: 'login works',
            title: 'login works',
            location: '/spec.ts:5',
            requirements: ['R1'],
            pathTypes: ['happy', 'sad'],
          },
        ],
        failed: [],
      }),
    )
    expect(readRunSummary(tmpDir)?.knownTests?.[0]).toMatchObject({
      id: 't1',
      requirements: ['R1'],
      pathTypes: ['happy', 'sad'],
    })
  })

  it('normalizes duplicate knownTests from line-drifted targeted reruns', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        total: 3,
        passed: 1,
        passedNames: ['test-case-line-drift'],
        passedIds: ['old-id'],
        knownTests: [
          {
            id: 'old-id',
            name: 'test-case-line-drift',
            title: 'line drift',
            titlePath: ['spec.ts', 'group', 'line drift'],
            location: '/spec.ts:10',
          },
          {
            id: 'new-id',
            name: 'test-case-line-drift',
            title: 'line drift',
            titlePath: ['spec.ts', 'group', 'line drift'],
            location: '/spec.ts:12',
          },
          {
            id: 'other-id',
            name: 'test-case-other',
            title: 'other',
            titlePath: ['spec.ts', 'group', 'other'],
            location: '/spec.ts:20',
          },
        ],
        failed: [],
      }),
    )

    expect(readRunSummary(tmpDir)).toMatchObject({
      total: 2,
      passedIds: ['new-id'],
      knownTests: [
        {
          id: 'new-id',
          name: 'test-case-line-drift',
          title: 'line drift',
          titlePath: ['spec.ts', 'group', 'line drift'],
          location: '/spec.ts:12',
        },
        {
          id: 'other-id',
          name: 'test-case-other',
        },
      ],
    })
  })

  it('remaps duplicate knownTest ids across skipped, failed, and running entries', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 3,
        passed: 0,
        skipped: 1,
        skippedIds: ['old-id', 'unmapped-skipped-id'],
        knownTests: [
          {
            id: 'old-id',
            name: 'test-case-line-drift',
            title: 'line drift',
            titlePath: ['spec.ts', 'group', 'line drift'],
          },
          {
            id: 'new-id',
            name: 'test-case-line-drift',
            title: 'line drift',
            titlePath: ['spec.ts', 'group', 'line drift'],
          },
          {
            id: 'other-id',
            name: 'test-case-other',
            title: 'other',
            titlePath: ['spec.ts', 'group', 'other'],
          },
          {
            id: 'same-id',
            name: 'test-case-same-id',
            title: 'same id',
            titlePath: ['spec.ts', 'group', 'same id'],
          },
          {
            id: 'same-id',
            name: 'test-case-same-id',
            title: 'same id',
            titlePath: ['spec.ts', 'group', 'same id'],
          },
          {
            id: 'untitled-old',
            name: 'test-case-untitled',
            titlePath: ['spec.ts', 'group', 'untitled'],
          },
          {
            id: 'untitled-new',
            name: 'test-case-untitled',
            titlePath: ['spec.ts', 'group', 'untitled'],
          },
          {
            id: 'no-title-path',
            name: 'test-case-no-title-path',
          },
        ],
        failed: [
          { id: 'old-id', name: 'test-case-line-drift' },
          { id: 'unmapped-id', name: 'test-case-unmapped' },
          { name: 'test-case-without-id' },
        ],
        running: { id: 'old-id', name: 'test-case-line-drift', location: 'spec.ts:10' },
        runningTests: [
          { id: 'old-id', name: 'test-case-line-drift', location: 'spec.ts:10' },
          { name: 'test-case-without-id', location: 'spec.ts:20' },
        ],
      }),
    )

    expect(readRunSummary(tmpDir)).toMatchObject({
      total: 5,
      skippedIds: ['new-id', 'unmapped-skipped-id'],
      failed: [
        { id: 'new-id', name: 'test-case-line-drift' },
        { id: 'unmapped-id', name: 'test-case-unmapped' },
        { name: 'test-case-without-id' },
      ],
      running: { id: 'new-id' },
      runningTests: [
        { id: 'new-id' },
        { name: 'test-case-without-id' },
      ],
    })
  })
})
