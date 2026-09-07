import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunDetail } from '../../runs/logic/run-store'
import type { RunManifest, RunSummary } from '../../runs/logic/run-detail'
import { suiteDigest } from '../../runs/logic/runtime/run-suite-snapshot'
import type { CoverageLedger } from '../../../../../../shared/coverage/types'
import { INTEGRITY_HINT_DISCLOSURE } from '../../../../../../shared/verification-strength/disclosure'
import { BEHAVIOR_CERTIFICATE_CHECKER_FILENAME, BEHAVIOR_CERTIFICATE_FORMAT, type BehaviorCertificate } from '../../../../../../shared/verification-strength/certificate'
import { buildBehaviorCertificate, requirementFingerprint } from './behavior-certificate'
import { ASSETS_DIR } from '../../../shared/bundled-assets'

// The certificate is a re-statement of evidence the run already holds, so it is
// built here from a REAL suite on disk (the run-start copy, then the live dir)
// and re-checked with the REAL bundled checker under a real node — a certificate
// whose checker was never run against it would be a claim about a claim.

const CHECKER = path.join(ASSETS_DIR, BEHAVIOR_CERTIFICATE_CHECKER_FILENAME)

const SPEC = `import { test, expect } from '@playwright/test'

test('shows the cart total', { tag: ['@req-R1'] }, async ({ page }) => {
  await page.goto('/cart')
  await expect(page.getByTestId('total')).toHaveText('$42.00')
  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible()
})

test('rejects an empty cart', { tag: ['@req-R2'] }, async ({ page }) => {
  await expect(page.getByText('Your cart is empty')).toBeVisible()
})

test('logs the order id', async ({ page }) => {
  await expect(page.locator('#order')).toHaveText(/ORD-\\d+/)
})

test.skip('prints a receipt', { tag: ['@req-R4'] }, async ({ page }) => {
  await expect(page.locator('#receipt')).toBeVisible()
})
`

let tmpDir: string
let featureDir: string
let logsDir: string
let snapshotDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-certificate-')))
  featureDir = path.join(tmpDir, 'features', 'checkout')
  logsDir = path.join(tmpDir, 'logs')
  snapshotDir = path.join(logsDir, 'runs', 'run-1', 'suite')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.mkdirSync(path.join(snapshotDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'e2e', 'cart.spec.ts'), SPEC)
  fs.writeFileSync(path.join(snapshotDir, 'e2e', 'cart.spec.ts'), SPEC)
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function lineOf(needle: string): number {
  return SPEC.slice(0, SPEC.indexOf(needle)).split('\n').length
}

function known(dir: string): NonNullable<RunSummary['knownTests']> {
  return [
    { name: 'test-case-shows-the-cart-total', title: 'shows the cart total', location: `${path.join(dir, 'e2e', 'cart.spec.ts')}:${lineOf("test('shows the cart total'")}` },
    { name: 'test-case-rejects-an-empty-cart', title: 'rejects an empty cart', location: `${path.join(dir, 'e2e', 'cart.spec.ts')}:${lineOf("test('rejects an empty cart'")}` },
    { name: 'test-case-logs-the-order-id', title: 'logs the order id', location: `${path.join(dir, 'e2e', 'cart.spec.ts')}:${lineOf("test('logs the order id'")}` },
    { name: 'test-case-prints-a-receipt', title: 'prints a receipt', location: `${path.join(dir, 'e2e', 'cart.spec.ts')}:${lineOf("test.skip('prints a receipt'")}` },
  ]
}

/** Total passed, empty-cart failed, receipt skipped, order id never reached. */
function summary(dir: string, over: Partial<RunSummary> = {}): RunSummary {
  return {
    complete: true,
    total: 4,
    passed: 1,
    knownTests: known(dir),
    passedNames: ['test-case-shows-the-cart-total'],
    skippedNames: ['test-case-prints-a-receipt'],
    failed: [{ name: 'test-case-rejects-an-empty-cart', error: { message: 'expected visible' } }],
    ...over,
  }
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1',
    feature: 'checkout',
    featureDir,
    startedAt: '2026-09-07T08:00:00.000Z',
    endedAt: '2026-09-07T08:01:00.000Z',
    status: 'failed',
    healCycles: 1,
    services: [],
    ...over,
  }
}

function snapshotted(over: Partial<RunManifest> = {}): RunManifest {
  return manifest({
    suiteSnapshot: { kind: 'taken', dir: snapshotDir, takenAt: '2026-09-07T08:00:00.000Z', digest: suiteDigest(snapshotDir) },
    specEdits: {
      checkedAt: '2026-09-07T08:01:00.000Z',
      pending: [
        { file: 'cart.spec.ts', change: 'modified', affectedTests: ['shows the cart total'], strength: { verdict: 'weaker', tests: [], baseline: 'run-start' } },
        // A deleted file has nothing to grade, so the differential records no strength;
        // the certificate lists the edit anyway (the verdict never executed it) with no verdict.
        { file: 'gone.spec.ts', change: 'deleted', affectedTests: [] },
      ],
      adopted: [{ at: '2026-09-07T08:00:30.000Z', by: 'human', files: ['other.spec.ts'] }],
    },
    integrity: {
      hints: [{ kind: 'weaker', file: 'cart.spec.ts', test: 'shows the cart total', requirements: ['R1'], was: ["toHaveText('$42.00')"], now: ['toBeVisible()'] }],
      disclosure: INTEGRITY_HINT_DISCLOSURE,
    },
    ...over,
  })
}

function detail(m: RunManifest, s: RunSummary | undefined = summary(snapshotDir)): RunDetail {
  return { runId: 'run-1', manifest: m, ...(s ? { summary: s } : {}) }
}

const LEDGER = {
  feature: 'checkout',
  requirements: [
    { requirement: { id: 'R1', title: 'Cart total', text: 'The cart shows its total', pathTypes: ['happy'] } },
    { requirement: { id: 'R3', title: 'Discounts', text: 'A discount code lowers the total', pathTypes: ['happy'] } },
  ],
} as unknown as CoverageLedger

function runChecker(certificate: BehaviorCertificate, args: string[] = []): { status: number; out: string } {
  const certPath = path.join(tmpDir, 'certificate.json')
  fs.writeFileSync(certPath, JSON.stringify(certificate))
  const result = spawnSync(process.execPath, [CHECKER, certPath, ...args], { encoding: 'utf8' })
  return { status: result.status ?? -1, out: result.stdout }
}

describe('buildBehaviorCertificate — from the run-start snapshot', () => {
  it('certifies the snapshot, every declared test with its assertions, the claims and the edits', () => {
    const cert = buildBehaviorCertificate(detail(snapshotted()), { coverage: LEDGER, now: () => '2026-09-07T09:00:00.000Z' })

    expect(cert.format).toBe(BEHAVIOR_CERTIFICATE_FORMAT)
    expect(cert.issuedAt).toBe('2026-09-07T09:00:00.000Z')
    expect(cert.suite).toMatchObject({
      source: 'run-start-snapshot',
      dir: snapshotDir,
      runStartCheck: 'matches',
      files: [{ path: 'e2e/cart.spec.ts', bytes: Buffer.byteLength(SPEC) }],
    })
    expect(cert.suite.digest).toBe(cert.suite.runStartDigest)
    expect(cert.suite).not.toHaveProperty('reason')

    // Roster order, honest statuses, one predicate row per assertion as written.
    expect(cert.tests.map((t) => [t.name, t.status])).toEqual([
      ['shows the cart total', 'passed'],
      ['rejects an empty cart', 'failed'],
      ['logs the order id', 'not run'],
      ['prints a receipt', 'skipped'],
    ])
    const total = cert.tests[0]
    expect(total).toMatchObject({ file: 'e2e/cart.spec.ts', line: lineOf("test('shows the cart total'"), requirements: ['R1'] })
    expect(total.predicates.map((p) => [p.matcher, p.strength])).toEqual([
      ['toHaveText', { kind: 'ranked', tier: 'exact', family: 'value' }],
      ['toBeVisible', { kind: 'ranked', tier: 'existential', family: 'state' }],
    ])
    expect(total.predicates[0]).toMatchObject({
      line: lineOf("toHaveText('$42.00')"),
      source: "await expect(page.getByTestId('total')).toHaveText('$42.00')",
      // Targets are re-printed canonically (double quotes), sources as written.
      target: 'page.getByTestId("total")',
      negated: false,
    })
    expect(cert.tests[2]).not.toHaveProperty('requirements')
    expect(cert.tests[3]).toMatchObject({ modifier: 'skip', requirements: ['R4'] })

    // Claims: ledger wording first (fingerprinted), then tag-only ids; the
    // outcome is this run's, never the ledger's latest-run join.
    expect(cert.claims).toEqual([
      { requirement: { id: 'R1', title: 'Cart total', text: 'The cart shows its total', fingerprint: requirementFingerprint('R1', 'Cart total', 'The cart shows its total') }, tests: ['shows the cart total'], outcome: 'all-passed' },
      { requirement: { id: 'R3', title: 'Discounts', text: 'A discount code lowers the total', fingerprint: requirementFingerprint('R3', 'Discounts', 'A discount code lowers the total') }, tests: [], outcome: 'no-tests' },
      { requirement: { id: 'R2' }, tests: ['rejects an empty cart'], outcome: 'some-failed' },
      { requirement: { id: 'R4' }, tests: ['prints a receipt'], outcome: 'not-run' },
    ])
    expect(requirementFingerprint('R1', 'Cart total', 'The cart shows its total')).toMatch(/^[0-9a-f]{16}$/)

    expect(cert.run).toEqual({
      runId: 'run-1', feature: 'checkout', executionType: 'run', status: 'failed',
      startedAt: '2026-09-07T08:00:00.000Z', endedAt: '2026-09-07T08:01:00.000Z', healCycles: 1,
      counts: { declared: 4, passed: 1, failed: 1, skipped: 1, interrupted: 0, notRun: 1 },
    })
    expect(cert.specEdits).toEqual({
      checkedAt: '2026-09-07T08:01:00.000Z',
      pending: [{ file: 'cart.spec.ts', change: 'modified', verdict: 'weaker' }, { file: 'gone.spec.ts', change: 'deleted' }],
      adopted: [{ at: '2026-09-07T08:00:30.000Z', by: 'human', files: ['other.spec.ts'] }],
    })
    expect(cert.hints).toHaveLength(1)
    expect(cert.disclosure).toBe(INTEGRITY_HINT_DISCLOSURE)

    expect(cert.statement).toContain('ran 4 declared tests for run run-1 of "checkout" from the suite snapshot taken at run start')
    expect(cert.statement).toContain('1 passed, 1 failed, 1 skipped, 0 interrupted, 1 never run; the run ended failed')
    // What is NOT proven is always said, with the weakening gap first.
    expect(cert.notProven[0]).toMatch(/^The absence of weakening/)
    expect(cert.notProven.join('\n')).toContain('requirement set is complete')
    expect(cert.notProven.join('\n')).toContain('marked not run')
    expect(cert.notProven.join('\n')).not.toContain('Which suite content')
    expect(cert.notProven.join('\n')).not.toContain('No requirement ledger')
  })

  it('re-verifies offline with the bundled checker, and the checker sees a tampered snapshot', () => {
    const cert = buildBehaviorCertificate(detail(snapshotted()), { coverage: LEDGER })

    const clean = runChecker(cert)
    expect(clean.out).toContain('ok   suite digest')
    expect(clean.out).toContain('matches the run-start digest')
    expect(clean.out).toContain('assertions located at their lines: 5/5')
    expect(clean.out).toContain('pending spec edits the verdict never executed: 2')
    expect(clean.out).toContain('RESULT: every check holds')
    expect(clean.status).toBe(0)

    // The snapshot is visible evidence, not a security boundary: an edit to
    // the copy after the certificate was issued is exactly what a reader must
    // be able to see.
    fs.appendFileSync(path.join(snapshotDir, 'e2e', 'cart.spec.ts'), '\n// tampered\n')
    const tampered = runChecker(cert)
    expect(tampered.out).toContain('FAIL spec e2e/cart.spec.ts: sha256 differs')
    expect(tampered.out).toContain('differs from certified')
    expect(tampered.out).toContain('differs from the run-start digest')
    expect(tampered.out).toMatch(/RESULT: \d+ check\(s\) failed/)
    expect(tampered.status).toBe(1)
  })

  it('checker: a moved or missing assertion, an extra spec, and an absent suite are each named', () => {
    const cert = buildBehaviorCertificate(detail(snapshotted()), { coverage: LEDGER })
    const other = path.join(tmpDir, 'other-suite')
    fs.mkdirSync(path.join(other, 'e2e'), { recursive: true })
    // Same spec with a blank line inserted at the top: hashes and lines both move.
    fs.writeFileSync(path.join(other, 'e2e', 'cart.spec.ts'), `\n${SPEC}`)
    fs.writeFileSync(path.join(other, 'e2e', 'extra.spec.ts'), "import { test } from '@playwright/test'\ntest('x', async () => {})\n")

    const moved = runChecker(cert, ['--suite', other])
    expect(moved.out).toContain('FAIL assertion not at e2e/cart.spec.ts:')
    expect(moved.out).toContain('FAIL spec e2e/extra.spec.ts: on disk but not in the certificate')
    expect(moved.out).toContain('FAIL assertions located at their lines: 0/5')
    expect(moved.status).toBe(1)

    const empty = path.join(tmpDir, 'empty-suite')
    fs.mkdirSync(empty)
    const missing = runChecker(cert, ['--suite', empty])
    expect(missing.out).toContain('FAIL spec e2e/cart.spec.ts: missing on disk')
    expect(missing.status).toBe(1)

    const gone = runChecker(cert, ['--suite', path.join(tmpDir, 'no-such-dir')])
    expect(gone.out).toContain('FAIL suite: directory not found')
    expect(gone.status).toBe(1)
  })

  it('checker: usage, unreadable file and a foreign format exit 2 without judging anything', () => {
    const usage = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' })
    expect(usage.stdout).toContain('usage:')
    expect(usage.status).toBe(2)

    const unreadable = spawnSync(process.execPath, [CHECKER, path.join(tmpDir, 'nope.json')], { encoding: 'utf8' })
    expect(unreadable.stdout).toContain('cannot read certificate')
    expect(unreadable.status).toBe(2)

    const foreign = path.join(tmpDir, 'foreign.json')
    fs.writeFileSync(foreign, JSON.stringify({ format: 'somebody-else@9' }))
    const result = spawnSync(process.execPath, [CHECKER, foreign], { encoding: 'utf8' })
    expect(result.stdout).toContain('unsupported certificate format: somebody-else@9')
    expect(result.status).toBe(2)
  })

  it('flags a snapshot whose digest no longer matches what the run recorded', () => {
    const edited = snapshotted({ suiteSnapshot: { kind: 'taken', dir: snapshotDir, takenAt: '2026-09-07T08:00:00.000Z', digest: 'deadbeef' } })

    const cert = buildBehaviorCertificate(detail(edited), { coverage: LEDGER })

    expect(cert.suite).toMatchObject({ source: 'run-start-snapshot', runStartCheck: 'differs', runStartDigest: 'deadbeef' })
    expect(cert.notProven.join('\n')).toContain('edited after the run began')
  })

  it('lists a roster test the suite does not declare without a file, and a declared test the roster missed as not run', () => {
    const s = summary(snapshotDir)
    s.knownTests = [
      ...s.knownTests!.slice(0, 2),
      { name: 'test-case-ghost', title: 'ghost', location: `${path.join(snapshotDir, 'e2e', 'cart.spec.ts')}:99` },
    ]
    const cert = buildBehaviorCertificate(detail(snapshotted(), s))

    expect(cert.tests.map((t) => [t.name, t.status, t.file])).toEqual([
      ['shows the cart total', 'passed', 'e2e/cart.spec.ts'],
      ['rejects an empty cart', 'failed', 'e2e/cart.spec.ts'],
      ['ghost', 'not run', undefined],
      ['logs the order id', 'not run', 'e2e/cart.spec.ts'],
      ['prints a receipt', 'not run', 'e2e/cart.spec.ts'],
    ])
    expect(cert.tests[2].predicates).toEqual([])
    expect(cert.run.counts).toEqual({ declared: 5, passed: 1, failed: 1, skipped: 0, interrupted: 0, notRun: 3 })
    // The checker's arithmetic holds for appended tests too.
    expect(runChecker(cert).out).toContain('ok   tests listed: 5 (declared 5)')
  })

  it('locates a test by title when its recorded file is outside the suite, and refuses an ambiguous title', () => {
    fs.writeFileSync(path.join(snapshotDir, 'e2e', 'dup.spec.ts'), "import { test, expect } from '@playwright/test'\ntest('logs the order id', async ({ page }) => {\n  await expect(page).toHaveTitle('x')\n})\n")
    const s = summary(snapshotDir)
    // Locations from somewhere else entirely — a run recorded against another checkout.
    s.knownTests = s.knownTests!.map((k) => ({ ...k, location: `/elsewhere/cart.spec.ts:1` }))
    const cert = buildBehaviorCertificate(detail(snapshotted(
      { suiteSnapshot: { kind: 'taken', dir: snapshotDir, takenAt: 'x', digest: suiteDigest(snapshotDir) } },
    ), s))

    const byName = new Map(cert.tests.map((t) => [t.name, t]))
    expect(byName.get('shows the cart total')).toMatchObject({ file: 'e2e/cart.spec.ts' })
    // 'logs the order id' now appears in two files: unlocated in the roster row,
    // and both declarations are appended as not run rather than one being guessed.
    expect(byName.get('logs the order id')).toMatchObject({ status: 'not run' })
    expect(cert.tests.filter((t) => t.name === 'logs the order id').map((t) => t.file).sort()).toEqual(['e2e/cart.spec.ts', 'e2e/dup.spec.ts', undefined].sort())
  })

  it('records outcomes that span several executions', () => {
    const cert = buildBehaviorCertificate(detail(snapshotted(), summary(snapshotDir, { mergedFromPriorExecution: true })))

    expect(cert.run.spansExecutions).toBe(true)
    expect(cert.notProven.join('\n')).toContain('span several partial executions')
  })

  it('carries guards and unreadable expect forms rather than dropping them', () => {
    fs.writeFileSync(path.join(snapshotDir, 'e2e', 'cart.spec.ts'), `import { test, expect } from '@playwright/test'
test('guarded', async ({ page }) => {
  test.skip(process.env.CI === '1', 'flaky on CI')
  const assertion = expect(page.locator('#a'))
  await expect(page.locator('#b')).toBeVisible()
})
`)
    const s = summary(snapshotDir, { knownTests: [{ name: 'test-case-guarded', title: 'guarded', location: `${path.join(snapshotDir, 'e2e', 'cart.spec.ts')}:2` }], passedNames: ['test-case-guarded'], failed: [], skippedNames: [] })
    const cert = buildBehaviorCertificate(detail(snapshotted({ suiteSnapshot: { kind: 'taken', dir: snapshotDir, takenAt: 'x', digest: suiteDigest(snapshotDir) } }), s))

    expect(cert.tests[0].guards).toEqual([expect.objectContaining({ kind: 'skip', condition: 'process.env.CI === "1"' })])
    expect(cert.tests[0].unparsed).toEqual([expect.objectContaining({ source: expect.stringContaining("expect(page.locator('#a'))") })])
    expect(cert.tests[0].predicates.map((p) => p.matcher)).toEqual(['toBeVisible'])
  })
})

describe('buildBehaviorCertificate — without a run-start snapshot', () => {
  it('reads the live dir and says so, and says the boundary and the ledger are missing', () => {
    const cert = buildBehaviorCertificate(detail(manifest({ executionType: 'verify', endedAt: undefined }), summary(featureDir)))

    expect(cert.suite).toMatchObject({
      source: 'live-feature-dir',
      dir: featureDir,
      runStartCheck: 'unverifiable',
      reason: 'the run was recorded before the run-start snapshot boundary existed',
    })
    expect(cert.suite).not.toHaveProperty('runStartDigest')
    expect(cert.run).toMatchObject({ executionType: 'verify' })
    expect(cert.run).not.toHaveProperty('endedAt')
    expect(cert).not.toHaveProperty('specEdits')
    expect(cert.hints).toEqual([])
    expect(cert.disclosure).toBe(INTEGRITY_HINT_DISCLOSURE)
    expect(cert.statement).toContain('from the live suite directory as it read when this certificate was issued')
    const notProven = cert.notProven.join('\n')
    expect(notProven).toContain('Which suite content the run executed. the run was recorded before the run-start snapshot boundary existed')
    expect(notProven).toContain('Which live spec edits the verdict never executed')
    expect(notProven).toContain('No requirement ledger was attached')
    // Tag-only claims still name their ids, with nothing to fingerprint.
    expect(cert.claims.map((c) => c.requirement)).toEqual([{ id: 'R1' }, { id: 'R2' }, { id: 'R4' }])

    const checked = runChecker(cert)
    expect(checked.out).toContain('note the run recorded no run-start digest')
    expect(checked.out).toContain('unknown (no snapshot boundary)')
    expect(checked.status).toBe(0)
  })

  it('names a failed snapshot, and a snapshot directory that has since vanished', () => {
    const failed = buildBehaviorCertificate(detail(manifest({ suiteSnapshot: { kind: 'unavailable', at: 'x', reason: 'EACCES' } }), summary(featureDir)))
    expect(failed.suite).toMatchObject({ source: 'live-feature-dir', reason: 'the run-start snapshot failed (EACCES); the run executed the live suite', runStartCheck: 'unverifiable' })

    fs.rmSync(snapshotDir, { recursive: true })
    const vanished = buildBehaviorCertificate(detail(snapshotted(), summary(featureDir)))
    expect(vanished.suite).toMatchObject({ source: 'live-feature-dir', dir: featureDir, runStartCheck: 'differs', reason: 'the run-start snapshot directory no longer exists; the live suite was read instead' })
  })

  it('certifies nothing about the suite when the run recorded no readable directory', () => {
    const none = buildBehaviorCertificate(detail(manifest({ featureDir: undefined }), summary(featureDir)))
    expect(none.suite).toEqual({ source: 'none', digest: expect.stringMatching(/^[0-9a-f]{64}$/), runStartCheck: 'unverifiable', reason: 'the run recorded no readable suite directory', files: [] })
    expect(none.statement).toContain('a suite directory this certificate could not read')
    expect(none.tests.every((t) => t.file === undefined && t.predicates.length === 0)).toBe(true)

    const missing = buildBehaviorCertificate(detail(manifest({ featureDir: path.join(tmpDir, 'gone') }), summary(featureDir)))
    expect(missing.suite.source).toBe('none')

    const checked = runChecker(none)
    expect(checked.out).toContain('FAIL suite: no directory to check against')
    expect(checked.status).toBe(1)
  })

  it('speaks in the singular for a one-test run', () => {
    const one = summary(featureDir, { total: 1, knownTests: known(featureDir).slice(0, 1), failed: [], skippedNames: [] })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'cart.spec.ts'), SPEC.split("test('rejects")[0])
    const cert = buildBehaviorCertificate(detail(manifest(), one))
    expect(cert.statement).toContain('ran 1 declared test for run')
    expect(cert.run.counts).toEqual({ declared: 1, passed: 1, failed: 0, skipped: 0, interrupted: 0, notRun: 0 })
  })
})

describe('the bundled checker', () => {
  it('is plain Node with no imports beyond the runtime', () => {
    const source = fs.readFileSync(CHECKER, 'utf8')
    expect(source.match(/^import .* from '([^']+)'/gm)!.map((line) => line.replace(/.* from '([^']+)'/, '$1')))
      .toEqual(['node:crypto', 'node:fs', 'node:path'])
    expect(() => execFileSync(process.execPath, ['--check', CHECKER])).not.toThrow()
  })
})
