import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ROBUSTNESS_ENVELOPE_FORMAT, type RobustnessEnvelope } from '../../../../../../../shared/robustness/types'
import type { RobustnessCellRequest, RobustnessCellResult, RobustnessCellRunner } from './cell-runner'
import { RobustnessJobConflictError, abortRobustnessJob, envelopeAtoms, judgeCell, planRobustnessMatrix, startRobustnessJob, type PlannedCell } from './matrix'
import { RobustnessJobRunStore } from './store'
import type { RunSummary } from '../run-detail'

// The matrix is planned from a GREEN run's on-disk record and judged from each
// cell run's summary. Both are files here: a logs dir with one finished run
// (manifest, summary, the suite snapshot with `@requirement` tags) and a fake
// cell runner that answers with whatever summary the test scripts. What the
// tests pin is the D16 contract — cells are file × atom, findings name tests
// and requirements, unjudgeable cells are skipped by name, and no count of
// passing cells is ever written.

const FORMAT = ROBUSTNESS_ENVELOPE_FORMAT
const FULL: RobustnessEnvelope = {
  format: FORMAT,
  latency: { ms: 300 },
  duplicate: { gapMs: 500, match: 'WRITE /**' },
  restart: [{ slot: 'catalog', afterNth: 2, match: 'WRITE /**' }],
}
const RUN_ID = 'run-green'

let tmp: string
let logsDir: string
let runDir: string
let suiteDir: string
let store: RobustnessJobRunStore

const now = () => '2026-09-10T00:00:00Z'

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    complete: true,
    total: 3,
    passed: 3,
    passedNames: ['test-case-browse', 'test-case-checkout', 'test-case-admin'],
    failed: [],
    knownTests: [
      { name: 'test-case-browse', title: 'browse', listLine: 'e2e/storefront.spec.ts:3:1 › browse', location: path.join(suiteDir, 'e2e', 'storefront.spec.ts:3') },
      { name: 'test-case-checkout', title: 'checkout', listLine: 'e2e/storefront.spec.ts:6:1 › checkout', location: path.join(suiteDir, 'e2e', 'storefront.spec.ts:6') },
      { name: 'test-case-admin', title: 'admin', listLine: 'e2e/admin.spec.ts:3:1 › admin', location: path.join(suiteDir, 'e2e', 'admin.spec.ts:3') },
    ],
    ...overrides,
  } as RunSummary
}

function writeGreenRun(opts: { summary?: RunSummary | null; manifest?: Record<string, unknown>; snapshot?: boolean } = {}) {
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId: RUN_ID, feature: 'storefront-journey', status: 'passed', startedAt: now(), healCycles: 0, services: [], repoPaths: [], env: 'local',
    ...opts.manifest,
  }))
  if (opts.summary !== null) fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify(opts.summary ?? summary()))
  if (opts.snapshot !== false) {
    fs.mkdirSync(path.join(suiteDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(suiteDir, 'e2e', 'storefront.spec.ts'), [
      "import { test } from '@playwright/test'",
      '// @requirement R1',
      "test('browse', async () => {})",
      '// @requirement R2',
      '// @requirement R3',
      "test('checkout', async () => {})",
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(suiteDir, 'e2e', 'admin.spec.ts'), [
      "import { test } from '@playwright/test'",
      '',
      "test('admin', async () => {})",
      '',
    ].join('\n'))
  }
}

interface CellScript {
  /** Titles of the tests that fail — when `when` (default: always) says the envelope exposes them. The summary names them by slug. */
  fail?: string[]
  /** The stand-in app: does this envelope expose the defect? `call` counts this cell's runs. */
  when?: (envelope: RobustnessEnvelope, call: number) => boolean
  status?: RobustnessCellResult['status']
  noSummary?: boolean
}

/** A cell runner scripted per spec file (or `file@atom`): which of the cell's
 *  tests fail under which envelopes, or a status with no summary at all. Shrink
 *  replays arrive here too, under the cell's own selection. Records every request. */
function scriptedRunner(script: Record<string, CellScript>): { runner: RobustnessCellRunner; requests: RobustnessCellRequest[] } {
  const requests: RobustnessCellRequest[] = []
  const calls = new Map<string, number>()
  let n = 0
  const runner: RobustnessCellRunner = async (request) => {
    requests.push(request)
    const runId = `cell-${++n}`
    const file = request.selection.reason.match(/cell: (\S+) under/)![1]
    const atom = request.selection.reason.match(/under (\w+)\./)![1]
    const key = `${file}@${atom}`
    const call = (calls.get(key) ?? 0) + 1
    calls.set(key, call)
    const plan = script[key] ?? script[file] ?? {}
    if (plan.noSummary) return { runId, status: plan.status ?? 'aborted' }
    const fail = (plan.when ?? (() => true))(request.envelope, call) ? plan.fail ?? [] : []
    return {
      runId,
      status: plan.status ?? (fail.length ? 'failed' : 'passed'),
      summary: { complete: true, total: 0, passed: 0, failed: fail.map((title) => ({ name: `test-case-${title}`, error: `${title} broke` })) } as unknown as RunSummary,
    }
  }
  return { runner, requests }
}

/** Every file under `dir` as relative path → bytes (hex), so a whole run record
 *  can be compared before and after the matrix ran over it. */
function treeBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const abs = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs).toString('hex')
  }
  return out
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-robustness-matrix-')))
  logsDir = path.join(tmp, 'logs')
  runDir = path.join(logsDir, 'runs', RUN_ID)
  suiteDir = path.join(runDir, 'suite')
  store = new RobustnessJobRunStore(logsDir)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('envelopeAtoms', () => {
  it('splits an envelope into one-atom envelopes, keeping every restart together and dropping an empty restart list', () => {
    expect(envelopeAtoms(FULL)).toEqual([
      { atom: 'latency', envelope: { format: FORMAT, latency: { ms: 300 } } },
      { atom: 'duplicate', envelope: { format: FORMAT, duplicate: { gapMs: 500, match: 'WRITE /**' } } },
      { atom: 'restart', envelope: { format: FORMAT, restart: [{ slot: 'catalog', afterNth: 2, match: 'WRITE /**' }] } },
    ])
    expect(envelopeAtoms({ format: FORMAT, restart: [] })).toEqual([])
  })
})

describe('planRobustnessMatrix', () => {
  it('lays out spec file × atom in file order, each cell a whole-file test list against the run snapshot', () => {
    writeGreenRun()
    const plan = planRobustnessMatrix(logsDir, RUN_ID, FULL)
    expect(plan.suiteDir).toBe(suiteDir)
    expect(plan.env).toBe('local')
    expect([...plan.greenPassed]).toEqual(['test-case-browse', 'test-case-checkout', 'test-case-admin'])
    expect(plan.cells.map((c) => c.cell)).toEqual([
      { specFile: 'e2e/admin.spec.ts', atom: 'latency' },
      { specFile: 'e2e/admin.spec.ts', atom: 'duplicate' },
      { specFile: 'e2e/admin.spec.ts', atom: 'restart' },
      { specFile: 'e2e/storefront.spec.ts', atom: 'latency' },
      { specFile: 'e2e/storefront.spec.ts', atom: 'duplicate' },
      { specFile: 'e2e/storefront.spec.ts', atom: 'restart' },
    ])
    expect(plan.cells[3].envelope).toEqual({ format: FORMAT, latency: { ms: 300 } })
    expect(plan.cells[3].selection).toEqual({
      kind: 'test-list',
      testList: ['e2e/storefront.spec.ts:3:1 › browse', 'e2e/storefront.spec.ts:6:1 › checkout'],
      selected: 2,
      total: 3,
      mode: 'robustness-cell',
      reason: 'Robustness Lab cell: e2e/storefront.spec.ts under latency.',
    })
    expect(plan.cells[3].tests.map((t) => t.title)).toEqual(['browse', 'checkout'])
  })

  it('falls back to a title grep when the summary predates list lines, and to the live suite folder when the snapshot is gone', () => {
    const featureDir = path.join(tmp, 'live-suite')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const tests = summary().knownTests!.map(({ listLine: _dropped, ...rest }) => ({ ...rest, location: rest.location!.replace(suiteDir, featureDir) }))
    writeGreenRun({ summary: summary({ knownTests: tests }), manifest: { featureDir }, snapshot: false })
    const plan = planRobustnessMatrix(logsDir, RUN_ID, { format: FORMAT, latency: { ms: 300 } })
    expect(plan.suiteDir).toBe(featureDir)
    expect(plan.cells.map((c) => c.cell.specFile)).toEqual(['e2e/admin.spec.ts', 'e2e/storefront.spec.ts'])
    expect(plan.cells[1].selection).toMatchObject({ kind: 'grep', grep: '(?:browse|checkout)', selected: 2, total: 3 })
  })

  it('refuses to plan from a run that cannot supply an inventory', () => {
    expect(() => planRobustnessMatrix(logsDir, RUN_ID, { format: FORMAT })).toThrow('the robustness envelope declares no atom — nothing to perturb')
    writeGreenRun({ summary: null })
    expect(() => planRobustnessMatrix(logsDir, RUN_ID, FULL)).toThrow(`run ${RUN_ID} has no test inventory to build the matrix from`)
    writeGreenRun({ summary: summary({ knownTests: [] }) })
    expect(() => planRobustnessMatrix(logsDir, RUN_ID, FULL)).toThrow('has no test inventory')
    writeGreenRun({ summary: summary({ knownTests: [{ name: 'test-case-browse', title: 'browse' }] }) })
    expect(() => planRobustnessMatrix(logsDir, RUN_ID, FULL)).toThrow(`run ${RUN_ID} recorded no location for "browse" — run the suite again so every test has one`)
    fs.rmSync(suiteDir, { recursive: true, force: true })
    writeGreenRun({ snapshot: false })
    expect(() => planRobustnessMatrix(logsDir, RUN_ID, FULL)).toThrow(`run ${RUN_ID} has no suite folder on disk to read specs from`)
  })
})

describe('judgeCell', () => {
  const planned = (): PlannedCell => ({
    cell: { specFile: 'e2e/storefront.spec.ts', atom: 'latency' },
    envelope: { format: FORMAT, latency: { ms: 300 } },
    selection: { kind: 'grep', grep: 'x', selected: 2, total: 3, mode: 'robustness-cell', reason: 'r' },
    tests: [{ name: 'test-case-browse', title: 'browse' }, { name: 'test-case-checkout', title: 'checkout' }],
  })
  const plan = () => ({ cells: [], suiteDir: '/s', greenPassed: new Set(['test-case-browse', 'test-case-checkout']) })
  // Tags are read from the source by TITLE — a slug name must resolve nothing.
  const requirementsOf = (test: { name: string; title: string }) => (test.title === 'checkout' ? ['R2', 'R3'] : undefined)

  it('counts only a failure of a test the green run passed, and never a test outside the cell', () => {
    const judged = judgeCell(planned(), {
      runId: 'c1',
      status: 'failed',
      summary: { failed: [{ name: 'test-case-checkout' }, { name: 'test-case-admin' }, { name: 'test-case-browse' }] } as unknown as RunSummary,
    }, { ...plan(), greenPassed: new Set(['test-case-checkout']) }, requirementsOf)
    expect(judged).toEqual({
      kind: 'finding',
      finding: {
        cell: { specFile: 'e2e/storefront.spec.ts', atom: 'latency' },
        runId: 'c1',
        failedTests: ['checkout'],
        requirements: ['R2', 'R3'],
        status: 'found',
        envelope: { format: FORMAT, latency: { ms: 300 } },
      },
    })
  })

  it('is clean when the cell passed, and skipped — with the reason — when it neither passed nor failed a test or wrote no summary', () => {
    const empty = { failed: [] } as unknown as RunSummary
    expect(judgeCell(planned(), { runId: 'c1', status: 'passed', summary: empty }, plan(), requirementsOf)).toEqual({ kind: 'clean' })
    expect(judgeCell(planned(), { runId: 'c2', status: 'aborted', summary: empty }, plan(), requirementsOf)).toEqual({
      kind: 'skipped',
      skipped: { cell: planned().cell, runId: 'c2', reason: 'run c2 ended aborted without a failing test in e2e/storefront.spec.ts' },
    })
    expect(judgeCell(planned(), { runId: 'c3', status: 'failed' }, plan(), requirementsOf)).toEqual({
      kind: 'skipped',
      skipped: { cell: planned().cell, runId: 'c3', reason: 'run c3 ended failed without a test summary' },
    })
  })
})

describe('startRobustnessJob', () => {
  it('returns a running record at once, runs every cell in order under its one-atom envelope, shrinks each finding, and ends done with findings and skips — never a pass count', async () => {
    writeGreenRun()
    const { runner, requests } = scriptedRunner({
      // A replayed write breaks checkout whenever there IS a duplicate, at any gap.
      'e2e/storefront.spec.ts@duplicate': { fail: ['checkout'], when: (env) => env.duplicate !== undefined },
      // A catalog reboot loses the cart; `admin` is not in this file and must be ignored.
      'e2e/storefront.spec.ts@restart': { fail: ['browse', 'checkout', 'admin'], when: (env) => (env.restart ?? []).length > 0 },
      'e2e/admin.spec.ts@latency': { noSummary: true, status: 'aborted' },
    })
    const { manifest, completion } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: FULL }, { store, runCell: runner, now, newJobId: () => 'rj-1' })
    expect(manifest).toEqual({
      jobId: 'rj-1', feature: 'storefront-journey', runId: RUN_ID, envelope: FULL, status: 'running', startedAt: now(),
      cells: { planned: 6, done: 0 }, findings: [], skipped: [],
      log: `matrix from run ${RUN_ID}: 2 spec files × 3 atoms (latency, duplicate, restart) = 6 cells\n`,
    })
    expect(store.activeFor('storefront-journey')?.jobId).toBe('rj-1')
    await completion

    // 6 cells, then shrink: duplicate = opening + 1 ddmin + 4 gap bisections + 3 replays; restart = opening + 1 ddmin + 3 replays.
    expect(requests).toHaveLength(6 + 9 + 5)
    expect(requests.slice(0, 6).map((r) => r.envelope)).toEqual([
      { format: FORMAT, latency: { ms: 300 } },
      { format: FORMAT, duplicate: { gapMs: 500, match: 'WRITE /**' } },
      { format: FORMAT, restart: FULL.restart },
      { format: FORMAT, latency: { ms: 300 } },
      { format: FORMAT, duplicate: { gapMs: 500, match: 'WRITE /**' } },
      { format: FORMAT, restart: FULL.restart },
    ])
    expect(requests[0]).toMatchObject({ feature: 'storefront-journey', env: 'local', selection: { kind: 'test-list', testList: ['e2e/admin.spec.ts:3:1 › admin'] } })

    const final = store.get('rj-1')!
    expect(final.status).toBe('done')
    expect(final.endedAt).toBe(now())
    expect(final.cells).toEqual({ planned: 6, done: 6 })
    expect(final.findings).toMatchObject([
      {
        cell: { specFile: 'e2e/storefront.spec.ts', atom: 'duplicate' }, runId: 'cell-5', failedTests: ['checkout'], requirements: ['R2', 'R3'],
        envelope: { format: FORMAT, duplicate: { gapMs: 500, match: 'WRITE /**' } },
        status: 'confirmed', repro: 'duplicate WRITE /** after 31 ms',
        shrink: { status: 'confirmed', probes: 5, budgetExhausted: false, confirmations: { asked: 3, reproduced: 3 }, envelope: { format: FORMAT, duplicate: { gapMs: 31, match: 'WRITE /**' } } },
      },
      {
        cell: { specFile: 'e2e/storefront.spec.ts', atom: 'restart' }, runId: 'cell-6', failedTests: ['browse', 'checkout'], requirements: ['R1', 'R2', 'R3'],
        envelope: { format: FORMAT, restart: FULL.restart },
        status: 'confirmed', repro: 'restart catalog on WRITE /** #2',
        shrink: { status: 'confirmed', probes: 1, envelope: { format: FORMAT, restart: FULL.restart } },
      },
    ])
    expect(final.findings[0].shrink?.steps).toHaveLength(1 + 5 + 3)
    // Shrink replays go through the cell's own selection, under the candidate envelope.
    expect(requests[6]).toMatchObject({ envelope: { format: FORMAT, duplicate: { gapMs: 500, match: 'WRITE /**' } }, selection: { kind: 'test-list', testList: ['e2e/storefront.spec.ts:3:1 › browse', 'e2e/storefront.spec.ts:6:1 › checkout'] } })
    expect(requests[7].envelope).toEqual({ format: FORMAT })
    expect(requests[8].envelope).toEqual({ format: FORMAT, duplicate: { gapMs: 250, match: 'WRITE /**' } })
    expect(final.skipped).toEqual([
      { cell: { specFile: 'e2e/admin.spec.ts', atom: 'latency' }, runId: 'cell-1', reason: 'run cell-1 ended aborted without a test summary' },
    ])
    const log = final.log.trimEnd().split('\n')
    expect(log.slice(0, 7)).toEqual([
      `matrix from run ${RUN_ID}: 2 spec files × 3 atoms (latency, duplicate, restart) = 6 cells`,
      'cell 1/6 e2e/admin.spec.ts × latency: skipped — run cell-1 ended aborted without a test summary',
      'cell 2/6 e2e/admin.spec.ts × duplicate: clean (run cell-2)',
      'cell 3/6 e2e/admin.spec.ts × restart: clean (run cell-3)',
      'cell 4/6 e2e/storefront.spec.ts × latency: clean (run cell-4)',
      'cell 5/6 e2e/storefront.spec.ts × duplicate: FINDING — checkout (run cell-5)',
      'cell 6/6 e2e/storefront.spec.ts × restart: FINDING — browse | checkout (run cell-6)',
    ])
    expect(log[7]).toBe('shrink 1/2 e2e/storefront.spec.ts × duplicate probe 1: duplicate WRITE /** after 500 ms → reproduced (run cell-7)')
    expect(log[8]).toBe('shrink 1/2 e2e/storefront.spec.ts × duplicate probe 2: no perturbation → did not reproduce (run cell-8)')
    expect(log[16]).toBe('shrink 1/2 e2e/storefront.spec.ts × duplicate: confirmed 3/3 → duplicate WRITE /** after 31 ms (5 search probes)')
    expect(log.at(-1)).toBe('shrink 2/2 e2e/storefront.spec.ts × restart: confirmed 3/3 → restart catalog on WRITE /** #2 (1 search probe)')
    expect(log).toHaveLength(7 + 9 + 1 + 5 + 1)
    expect(JSON.stringify(final)).not.toMatch(/"passed"/)
    expect(store.activeFor('storefront-journey')).toBeNull()
  })

  it('refuses a second matrix for a suite whose job is still running', () => {
    writeGreenRun()
    const held = new Promise<RobustnessCellResult>(() => { /* held */ })
    startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: FULL }, { store, runCell: () => held, newJobId: () => 'rj-1' })
    let caught: unknown
    try {
      startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: FULL }, { store, runCell: () => held })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RobustnessJobConflictError)
    expect(caught).toMatchObject({ statusCode: 409, feature: 'storefront-journey', existingJobId: 'rj-1', message: 'a robustness job is already running for storefront-journey' })
    // Another suite is not held up by it.
    expect(() => startRobustnessJob({ logsDir, feature: 'other', runId: RUN_ID, envelope: FULL }, { store, runCell: () => held })).not.toThrow()
  })

  it('hands a planning error to the caller without writing a job, and ends failed with the reason when a cell cannot be started', async () => {
    expect(() => startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: FULL }, { store, runCell: scriptedRunner({}).runner, now, newJobId: () => 'rj-1' }))
      .toThrow(`run ${RUN_ID} has no test inventory to build the matrix from`)
    expect(store.list()).toEqual([])

    writeGreenRun()
    const second = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, {
      store,
      runCell: async () => { throw new Error('another run (demo, run-9) holds its repos') },
      now,
      newJobId: () => 'rj-2',
    })
    await second.completion
    expect(store.get('rj-2')).toMatchObject({ status: 'failed', error: 'another run (demo, run-9) holds its repos', cells: { planned: 2, done: 0 } })

    const third = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, {
      store,
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error rejection must still be recorded as text
      runCell: async () => { throw 'shim never bound' },
      now,
      newJobId: () => 'rj-3',
    })
    await third.completion
    expect(store.get('rj-3')?.error).toBe('shim never bound')
  })

  it('keeps a finding that will not replay as unconfirmed, with the trace, and marks the status while shrinking', async () => {
    writeGreenRun()
    const seen: string[][] = []
    store.onEvent(() => { seen.push(store.get('rj-1')?.findings.map((f) => f.status) ?? []) })
    const { runner } = scriptedRunner({
      // Fails at discovery and never again: a flake, not a robustness finding.
      'e2e/admin.spec.ts@latency': { fail: ['admin'], when: (_env, call) => call === 1 },
      // Fails at discovery and through the one-probe search, then loses one of the three replays.
      'e2e/storefront.spec.ts@latency': { fail: ['browse'], when: (env, call) => env.latency !== undefined && call !== 6 },
    })
    const { completion } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, { store, runCell: runner, now, newJobId: () => 'rj-1', shrink: { maxProbes: 1, confirmations: 3, minStepMs: 100 } })
    await completion
    const final = store.get('rj-1')!
    expect(final.status).toBe('done')
    expect(final.findings.map((f) => [f.cell.specFile, f.status, f.repro, f.shrink?.status, f.shrink?.confirmations])).toEqual([
      ['e2e/admin.spec.ts', 'unconfirmed', 'latency 300 ms', 'not-reproduced', { asked: 0, reproduced: 0 }],
      ['e2e/storefront.spec.ts', 'unconfirmed', 'latency 300 ms', 'unconfirmed', { asked: 3, reproduced: 2 }],
    ])
    expect(final.log).toContain('shrink 1/2 e2e/admin.spec.ts × latency: did not reproduce even once under the envelope it was found with (0 search probes)')
    expect(final.log).toContain('shrink 2/2 e2e/storefront.spec.ts × latency: unconfirmed — replayed 2/3 at latency 300 ms (1 search probe, budget exhausted)')
    // The pane saw each finding pass through `shrinking` before its verdict landed.
    expect(seen).toContainEqual(['shrinking', 'found'])
    expect(seen).toContainEqual(['unconfirmed', 'shrinking'])
  })

  it('records a finding with no requirements when the failing spec file is not on disk to read tags from', async () => {
    const ghost = path.join(suiteDir, 'e2e', 'ghost.spec.ts:3')
    writeGreenRun({ summary: summary({ passedNames: ['test-case-browse', 'test-case-checkout', 'test-case-admin', 'test-case-ghost'], knownTests: [...summary().knownTests!, { name: 'test-case-ghost', title: 'ghost', location: ghost }] }) })
    const { runner } = scriptedRunner({ 'e2e/ghost.spec.ts': { fail: ['ghost'] } })
    const { completion } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, { store, runCell: runner, now, newJobId: () => 'rj-1' })
    await completion
    expect(store.get('rj-1')?.findings).toMatchObject([
      { cell: { specFile: 'e2e/ghost.spec.ts', atom: 'latency' }, runId: 'cell-2', failedTests: ['ghost'], requirements: [], envelope: { format: FORMAT, latency: { ms: 300 } } },
    ])
  })

  it('writes the matrix size in the singular when there is one of something', () => {
    writeGreenRun({ summary: summary({ passedNames: ['test-case-admin'], knownTests: [summary().knownTests![2]] }) })
    const { manifest } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, { store, runCell: () => new Promise(() => { /* held */ }) })
    expect(manifest.log).toBe(`matrix from run ${RUN_ID}: 1 spec file × 1 atom (latency) = 1 cell\n`)
  })

  it('leaves the green run\'s record byte-identical: a matrix with findings and shrinks writes only under robustness-jobs/, never into the run it was built from', async () => {
    writeGreenRun()
    const before = treeBytes(runDir)
    expect(Object.keys(before).sort()).toEqual(['e2e-summary.json', 'manifest.json', 'suite/e2e/admin.spec.ts', 'suite/e2e/storefront.spec.ts'])
    const { runner } = scriptedRunner({
      'e2e/storefront.spec.ts@duplicate': { fail: ['checkout'], when: (env) => env.duplicate !== undefined },
      'e2e/admin.spec.ts@latency': { noSummary: true, status: 'aborted' },
    })
    const { completion } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: FULL }, { store, runCell: runner, now, newJobId: () => 'rj-pin' })
    await completion

    const final = store.get('rj-pin')!
    expect(final.status).toBe('done')
    expect(final.findings.map((f) => f.status)).toEqual(['confirmed'])
    expect(final.skipped).toHaveLength(1)
    // The verdict the certificate and the ledger read is the green run's own files —
    // the stage adds a record beside them and changes nothing they say.
    expect(treeBytes(runDir)).toEqual(before)
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')).status).toBe('passed')
    const written = fs.readdirSync(logsDir).sort()
    expect(written).toEqual(['robustness-jobs', 'runs'])
    expect(fs.readdirSync(path.join(logsDir, 'runs'))).toEqual([RUN_ID])
  })

  it('stops at the next checkpoint when aborted: the running cell is told, findings so far stand, and the record says so', async () => {
    writeGreenRun()
    let releaseSecond: (() => void) | undefined
    const seen: Array<{ n: number; aborted: boolean }> = []
    const requests: RobustnessCellRequest[] = []
    const runCell: RobustnessCellRunner = async (request) => {
      requests.push(request)
      const n = requests.length
      if (n === 1) {
        // The first cell finds something, so there is a finding to keep.
        return { runId: 'cell-1', status: 'failed', summary: { complete: true, total: 0, passed: 0, failed: [{ name: 'test-case-admin', error: 'slow' }] } as unknown as RunSummary }
      }
      // The second cell hangs until its signal fires — as a real run does when
      // the store aborts it — and reports what it saw.
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
        request.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      seen.push({ n, aborted: request.signal?.aborted ?? false })
      return { runId: `cell-${n}`, status: 'aborted' }
    }
    const { manifest, completion } = startRobustnessJob({ logsDir, feature: 'storefront-journey', runId: RUN_ID, envelope: { format: FORMAT, latency: { ms: 300 } } }, { store, runCell, now, newJobId: () => 'rj-abort' })
    expect(manifest.cells).toEqual({ planned: 2, done: 0 })
    // Let cell 1 settle and cell 2 start waiting.
    while (requests.length < 2) await new Promise((r) => setTimeout(r, 1))
    expect(requests[0].signal?.aborted).toBe(false)

    expect(abortRobustnessJob('rj-abort')).toBe(true)
    await completion
    expect(seen).toEqual([{ n: 2, aborted: true }])
    expect(releaseSecond).toBeTypeOf('function')

    const final = store.get('rj-abort')!
    expect(final).toMatchObject({ status: 'aborted', endedAt: now(), error: 'Aborted', cells: { planned: 2, done: 1 } })
    expect(final.findings).toHaveLength(1)
    expect(final.findings[0]).toMatchObject({ cell: { specFile: 'e2e/admin.spec.ts', atom: 'latency' }, status: 'found' })
    expect(final.log.trimEnd().split('\n').at(-1)).toBe('aborted — the matrix was stopped before it finished; findings so far stand, nothing after them was judged')
    // No shrink ran for the finding: the abort was checked before it.
    expect(requests).toHaveLength(2)
    // The controller is released with the job.
    expect(abortRobustnessJob('rj-abort')).toBe(false)
    expect(store.activeFor('storefront-journey')).toBeNull()
  })

  it('answers false for a job it is not driving', () => {
    expect(abortRobustnessJob('nobody')).toBe(false)
  })

  it('mints a distinct job id per start when none is supplied', () => {
    writeGreenRun()
    const held = new Promise<RobustnessCellResult>(() => { /* held */ })
    const a = startRobustnessJob({ logsDir, feature: 'a', runId: RUN_ID, envelope: FULL }, { store, runCell: () => held })
    const b = startRobustnessJob({ logsDir, feature: 'b', runId: RUN_ID, envelope: FULL }, { store, runCell: () => held })
    expect(a.manifest.jobId).toMatch(/^rj_[0-9a-f]{12}$/)
    expect(b.manifest.jobId).not.toBe(a.manifest.jobId)
    expect(a.manifest.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
