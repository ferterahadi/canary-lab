// The saved suite's test roster, rebuilt from a finished run's reporter output.
// Every refusal here is a 409 rather than a partial list: a roster the UI can
// show but cannot map back to a source line would invite a click that opens the
// wrong file, or a file outside the snapshot entirely.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { recordedTestList } from './recorded-test-list'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'

let logsDir: string
let snapDir: string
let runDir: string

beforeEach(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-recorded-list-')))
  logsDir = path.join(tmp, 'logs')
  snapDir = path.join(tmp, 'snap')
  fs.mkdirSync(path.join(snapDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(snapDir, 'e2e/a.spec.ts'), "import { test, expect } from '@playwright/test'\ntest('adds to cart', async () => { expect(1).toBe(1) })\n")
  runDir = runDirFor(logsDir, 'r1')
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'r1', feature: 'demo', featureDir: path.join(tmp, 'features/demo'),
    startedAt: 'now', status: 'passed', services: [], healCycles: 0,
    suiteSnapshot: { kind: 'taken', dir: snapDir, takenAt: 'now', digest: 'abcdef0123456789' },
  })
})

const withKnownTests = (knownTests: unknown[]) =>
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({ knownTests }))

describe('recordedTestList', () => {
  it('reads the saved suite and attaches each recorded identity to its source line', () => {
    withKnownTests([{ name: 'adds to cart', title: 'adds to cart', location: `${path.join(snapDir, 'e2e/a.spec.ts')}:2` }])
    const { dir, tests } = recordedTestList(logsDir, 'demo', 'r1')
    expect(dir).toBe(snapDir)
    expect(tests).toEqual([expect.objectContaining({ file: path.join(snapDir, 'e2e/a.spec.ts'), line: 2, title: 'adds to cart' })])
  })

  // A reporter entry missing either half cannot be resolved to a place in the
  // source, and the roster is the thing that turns a row into a file to open.
  it.each([
    ['no location', () => ({ name: 'adds to cart', title: 'adds to cart' })],
    ['an unparseable location', () => ({ name: 'adds to cart', title: 'adds to cart', location: 'e2e/a.spec.ts' })],
    ['no title', () => ({ name: 'adds to cart', location: `${path.join(snapDir, 'e2e/a.spec.ts')}:2` })],
  ])('refuses the whole roster when an entry has %s', (_label, entry) => {
    withKnownTests([entry()])
    expect(() => recordedTestList(logsDir, 'demo', 'r1')).toThrow(/recorded test locations are unavailable/)
    expect(() => recordedTestList(logsDir, 'demo', 'r1')).toThrow(expect.objectContaining({ statusCode: 409 }))
  })
})
