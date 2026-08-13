import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import {
  restartPlanDetail,
  finalLifecyclePhase,
  summaryHasPassingEvidence,
  nonPassedSignatureFromPlan,
  computeVerificationPlan,
  computeRerunTargetsOrdered,
  computeNonPassedTargets,
  readLatestHealOnFailureThreshold,
} from './run-verdict'
import { specFileOfKnownTest } from './rerun-targets'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

// Branch-level cover for the verdict helpers that were unreachable while they
// lived inside orchestrator.ts as module-private functions. Each test names the
// arm it exists for, so a future edit that deletes the arm also fails a test
// with an explanatory name rather than only moving a coverage number.

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function mkFeatureDir(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rv-')))
  tmpDirs.push(root)
  const dir = path.join(root, 'features', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeSpec(featureDir: string, name: string, body: string): string {
  const dir = path.join(featureDir, 'e2e')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

const known = (name: string, title: string, location?: string) => ({
  name,
  title,
  ...(location ? { location } : {}),
})

// The only input that actually sets `ExtractResult.parseError`. TypeScript's
// parser is error-tolerant, so malformed syntax still yields a (test-less)
// tree and takes the ordinary path — nesting deep enough to overflow the
// parser's own recursion is what makes it throw.
const PARSER_OVERFLOW_SPEC = `test('deep', () => {${'('.repeat(20000)}${')'.repeat(20000)}})\n`

// Two tests declared on ONE source line share a `file:line` location while
// having distinct slugs — the only way the location de-duplication in the
// skipped/pending/non-passed loops can fire.
const TWO_TESTS_ONE_LINE =
  "import { test } from '@playwright/test'\n" +
  "test('alpha', async () => {}); test('beta', async () => {})\n"

const PARSEABLE_SPEC =
  "import { test } from '@playwright/test'\n" +
  "test('still parses', async () => {})\n"

// A spec that is listed but cannot be read — the real case is a file removed or
// re-permissioned between the directory listing and the read. `listSpecFiles`
// filters on `isFile()`, so a directory or dangling symlink is never listed and
// mode 0o000 is the only way in. Restores the mode so the temp dir still cleans
// up, and returns the readable sibling that must still be targeted.
function writeUnreadableSpec(featureDir: string, run: (good: string) => void): void {
  const bad = writeSpec(featureDir, 'a-unreadable.spec.ts', PARSEABLE_SPEC)
  const good = writeSpec(featureDir, 'b-good.spec.ts', PARSEABLE_SPEC)
  fs.chmodSync(bad, 0o000)
  try {
    run(good)
  } finally {
    fs.chmodSync(bad, 0o644)
  }
}

describe('restartPlanDetail', () => {
  it('mentions kept services that must be started before the rerun', () => {
    expect(restartPlanDetail(['api'], ['web'], ['worker'])).toContain(
      'Will start missing kept service worker before rerun.',
    )
  })

  it('pluralises the missing-kept list', () => {
    expect(restartPlanDetail([], [], ['a', 'b'])).toContain('missing kept services a, b')
  })

  it('falls back to the no-op sentence when nothing restarts, is kept, or is missing', () => {
    expect(restartPlanDetail([], [], [])).toBe('No service restart is required.')
  })
})

describe('finalLifecyclePhase', () => {
  it('maps the three terminal statuses', () => {
    expect(finalLifecyclePhase('passed')).toBe('passed')
    expect(finalLifecyclePhase('aborted')).toBe('aborted')
    expect(finalLifecyclePhase('failed')).toBe('failed')
  })

  it("falls through to 'completed' for any non-terminal status", () => {
    // The orchestrator only calls this on a terminal status, so this arm is the
    // guard for a status added later without a phase mapping.
    expect(finalLifecyclePhase('running')).toBe('completed')
  })
})

describe('summaryHasPassingEvidence', () => {
  it('trusts the reporter inventory when knownTests is present', () => {
    expect(summaryHasPassingEvidence({ knownTests: [known('t', 'a title')] })).toBe(true)
  })

  it('falls back to counts, requiring passed to reach a non-zero total', () => {
    expect(summaryHasPassingEvidence({ total: 2, passed: 2 })).toBe(true)
    expect(summaryHasPassingEvidence({ total: 2, passed: 1 })).toBe(false)
    // total 0 is "nothing ran", not "everything passed" — never-run must not
    // round up to passed.
    expect(summaryHasPassingEvidence({ total: 0, passed: 0 })).toBe(false)
  })
})

describe('nonPassedSignatureFromPlan', () => {
  it('returns an empty signature when everything already passed', () => {
    expect(nonPassedSignatureFromPlan({ kind: 'all-passed', total: 3 })).toBe('')
  })

  it('signs a full-suite plan by its total', () => {
    expect(nonPassedSignatureFromPlan({ kind: 'full-suite', reason: 'r', total: 4 })).toBe('full-suite:4')
  })
})

describe('computeVerificationPlan test-list selection', () => {
  const withLine = (name: string, title: string, listLine: string) => ({ name, title, listLine })

  it('selects by test-list when every not-yet-passed test carries a listLine', () => {
    const plan = computeVerificationPlan(mkFeatureDir(), {
      knownTests: [
        withLine('test-case-a', 'a title', 'a.spec.ts › suite › a title'),
        withLine('test-case-b', 'b title', 'b.spec.ts › b title'),
      ],
      passedNames: ['test-case-b'],
      failed: [{ name: 'test-case-a' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    expect(plan.selection.kind).toBe('test-list')
    if (plan.selection.kind !== 'test-list') return
    // Only the not-yet-passed test, named exactly — not the passing one that
    // a title-based grep could also have matched.
    expect(plan.selection.testList).toEqual(['a.spec.ts › suite › a title'])
  })

  it('falls back to grep when even one selected test has no listLine', () => {
    // All-or-nothing: a partial list would silently run a subset of the plan,
    // and the verdict would rest on a rerun that skipped tests nobody skipped.
    const plan = computeVerificationPlan(mkFeatureDir(), {
      knownTests: [
        withLine('test-case-a', 'a title', 'a.spec.ts › a title'),
        known('test-case-b', 'b title'),
      ],
      failed: [{ name: 'test-case-a' }, { name: 'test-case-b' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    expect(plan.selection.kind).toBe('grep')
  })

  it('deduplicates identical listLines rather than repeating an entry', () => {
    const plan = computeVerificationPlan(mkFeatureDir(), {
      knownTests: [
        withLine('test-case-a', 'a title', 'a.spec.ts › a title'),
        withLine('test-case-a-dup', 'a title', 'a.spec.ts › a title'),
      ],
      failed: [{ name: 'test-case-a' }, { name: 'test-case-a-dup' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    if (plan.selection.kind !== 'test-list') return
    expect(plan.selection.testList).toEqual(['a.spec.ts › a title'])
  })
})

describe('computeVerificationPlan', () => {
  it('falls back to the full suite when a failed test is missing from the inventory', () => {
    const plan = computeVerificationPlan(mkFeatureDir(), {
      knownTests: [known('test-case-a', 'a title')],
      failed: [{ name: 'test-case-ghost' }],
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('could not match 1 failed test in the known Playwright inventory')
  })

  it('pluralises the missing-failed fallback reason', () => {
    const plan = computeVerificationPlan(mkFeatureDir(), {
      knownTests: [known('test-case-a', 'a title')],
      failed: [{ name: 'test-case-g1' }, { name: 'test-case-g2' }],
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('could not match 2 failed tests')
  })

  it('falls back to the full suite when static extraction dropped a failed slug', () => {
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a happy path', async () => {})\n" +
      "test('b not yet run', async () => {})\n",
    )

    // No knownTests → the static-extraction path. One test is still pending so
    // the plan is not all-passed, and the failed slug matches nothing that was
    // extracted, so it is dropped and the plan widens to the full suite.
    const plan = computeVerificationPlan(featureDir, {
      passedNames: ['test-case-a-happy-path'],
      failed: [{ name: 'test-case-not-in-any-spec' }],
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('could not safely target 1 previously failed test')
  })

  it('pluralises the dropped-slug fallback reason', () => {
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a happy path', async () => {})\n" +
      "test('b not yet run', async () => {})\n",
    )

    const plan = computeVerificationPlan(featureDir, {
      passedNames: ['test-case-a-happy-path'],
      failed: [{ name: 'test-case-gone-one' }, { name: 'test-case-gone-two' }],
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('could not safely target 2 previously failed tests')
  })
})

describe('computeRerunTargetsOrdered', () => {
  it('skips a spec that fails to parse and yields no tests', () => {
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'broken.spec.ts', 'this is (not ) valid typescript {{{\n')
    writeSpec(featureDir, 'good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a good one', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, { passedNames: ['other'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    // Only the parseable spec contributes.
    expect(result.total).toBe(1)
  })

  it('maps a duplicated slug to its first location', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'dup.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('same name', async () => {})\n" +
      "test('same name', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['x'],
      failed: [{ name: 'test-case-same-name' }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    // Both lines share a slug, so the slug→location map keeps the first and the
    // second is skipped as already-claimed by the failed-first group.
    expect(result.failedFirst).toEqual([`${spec}:2`])
    expect(result.locations).toEqual([`${spec}:2`])
  })

  it('does not list a failed test again in the pending group', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('one', async () => {})\n" +
      "test('two', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-two'],
      failed: [{ name: 'test-case-one' }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${spec}:2`])
    expect(result.pending).not.toContain(`${spec}:2`)
  })

  it('reports extraction-failed when every spec is unparseable', () => {
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'broken.spec.ts', 'nope ((( {{{\n')

    expect(computeRerunTargetsOrdered(featureDir, {}).kind).toBe('extraction-failed')
  })

  it('skips a spec the TypeScript parser cannot walk without overflowing', () => {
    // Guard the fixture rather than trust it: if a future TypeScript raises its
    // recursion limit this stops producing a parseError, and the branch under
    // test would go quietly uncovered instead of failing here.
    expect(extractTestsFromSource('probe.spec.ts', PARSER_OVERFLOW_SPEC).parseError).toBeTruthy()

    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'a-overflow.spec.ts', PARSER_OVERFLOW_SPEC)
    const good = writeSpec(featureDir, 'b-good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('still parses', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, { passedNames: ['other'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    // The overflowing spec contributes nothing and must not abort extraction —
    // one unwalkable file cannot be allowed to widen the rerun to a full suite.
    expect(result.locations).toEqual([`${good}:2`])
  })

  it('counts a slug repeated in the failed list only once', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('flaky one', async () => {})\n",
    )

    // Playwright reports a retried test once per attempt, so the same name can
    // appear twice in `failed`.
    const result = computeRerunTargetsOrdered(featureDir, {
      failed: [{ name: 'test-case-flaky-one' }, { name: 'test-case-flaky-one' }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${spec}:2`])
  })

  it('skips a spec that cannot be read and still targets the readable one', () => {
    const featureDir = mkFeatureDir()
    writeUnreadableSpec(featureDir, (good) => {
      const result = computeRerunTargetsOrdered(featureDir, { passedNames: ['other'] })

      expect(result.kind).toBe('targeted')
      if (result.kind !== 'targeted') return
      expect(result.locations).toEqual([`${good}:2`])
    })
  })

  it('lists a location once when two skipped tests share a source line', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'pair.spec.ts', TWO_TESTS_ONE_LINE)

    const result = computeRerunTargetsOrdered(featureDir, {
      skippedNames: ['test-case-alpha', 'test-case-beta'],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    // Playwright reruns by file:line, so the same location twice would run the
    // pair twice rather than reach a second test.
    expect(result.skipped).toEqual([`${spec}:2`])
  })

  it('lists a location once when two pending tests share a source line', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'pair.spec.ts', TWO_TESTS_ONE_LINE)

    const result = computeRerunTargetsOrdered(featureDir, {})

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.pending).toEqual([`${spec}:2`])
  })
})

describe('computeNonPassedTargets', () => {
  it('skips an unparseable spec but still targets the parseable one', () => {
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'broken.spec.ts', 'still ((( not {{{ valid\n')
    const good = writeSpec(featureDir, 'good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('runs fine', async () => {})\n" +
      "test('also fine', async () => {})\n",
    )

    const result = computeNonPassedTargets(featureDir, { passedNames: ['test-case-runs-fine'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.locations).toEqual([`${good}:3`])
  })

  it('keeps same-named tests at different lines as separate targets', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'dup.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('twin', async () => {})\n" +
      "test('twin', async () => {})\n",
    )

    const result = computeNonPassedTargets(featureDir, { passedNames: ['unrelated'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    // Location is file:line, so a shared title is still two distinct targets —
    // dropping one would silently stop rerunning a real test.
    expect(result.locations).toEqual([`${spec}:2`, `${spec}:3`])
  })

  it('skips a spec the TypeScript parser cannot walk without overflowing', () => {
    expect(extractTestsFromSource('probe.spec.ts', PARSER_OVERFLOW_SPEC).parseError).toBeTruthy()

    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'a-overflow.spec.ts', PARSER_OVERFLOW_SPEC)
    const good = writeSpec(featureDir, 'b-good.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('still parses', async () => {})\n",
    )

    const result = computeNonPassedTargets(featureDir, { passedNames: ['other'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.locations).toEqual([`${good}:2`])
  })

  it('skips a spec that cannot be read and still targets the readable one', () => {
    const featureDir = mkFeatureDir()
    writeUnreadableSpec(featureDir, (good) => {
      const result = computeNonPassedTargets(featureDir, { passedNames: ['other'] })

      expect(result.kind).toBe('targeted')
      if (result.kind !== 'targeted') return
      expect(result.locations).toEqual([`${good}:2`])
    })
  })

  it('lists a location once when two non-passed tests share a source line', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'pair.spec.ts', TWO_TESTS_ONE_LINE)

    const result = computeNonPassedTargets(featureDir, { passedNames: ['unrelated'] })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.locations).toEqual([`${spec}:2`])
  })
})

describe('readLatestHealOnFailureThreshold', () => {
  const feature = (featureDir: string): FeatureConfig =>
    ({ name: 'demo', featureDir, healOnFailureThreshold: 1 }) as FeatureConfig

  it('re-reads the threshold from the config on disk', () => {
    const featureDir = mkFeatureDir()
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  featureDir: __dirname,',
      '  healOnFailureThreshold: 7,',
      '}',
      '',
    ].join('\n'))

    expect(readLatestHealOnFailureThreshold(feature(featureDir))).toBe(7)
  })

  it('matches a renamed feature directory by feature name', () => {
    const featureDir = mkFeatureDir()
    const renamed = path.join(path.dirname(featureDir), 'demo-renamed')
    fs.mkdirSync(renamed, { recursive: true })
    fs.writeFileSync(path.join(renamed, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  featureDir: "/not/the/directory/on/disk",',
      '  healOnFailureThreshold: 9,',
      '}',
      '',
    ].join('\n'))

    // featureDir no longer matches, so the name is the only way back to the
    // live config — without it the run would silently keep a stale threshold.
    expect(readLatestHealOnFailureThreshold(feature(featureDir))).toBe(9)
  })

  it('falls back to the in-memory threshold when nothing on disk matches', () => {
    expect(readLatestHealOnFailureThreshold(feature(mkFeatureDir()))).toBe(1)
  })
})

// A Playwright serial spec is one unit: its tests share a worker, run in
// declaration order, and hand state to each other. Re-running only the
// not-yet-passed members leaves the producers out, so the consumers fail on
// their own preconditions before touching the app — a heal loop that reads that
// as "the fix didn't work" can never go green. Measured on run
// 2026-08-13T0239-bi36: the borrow test passed in cycle 1, was excluded from
// every later rerun, and the return test then failed on an empty loan id
// forever while the app fix sitting in the worktree was correct.
describe('computeVerificationPlan with a serial spec', () => {
  const SERIAL_HEADER =
    "import { test } from '@playwright/test'\n" +
    "test.describe.configure({ mode: 'serial' })\n"

  // Mirrors the demo lending spec: borrow produces the loan id that return
  // consumes, and borrow passed in the previous cycle.
  function serialFeature(): { featureDir: string; spec: string } {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'lending.spec.ts', SERIAL_HEADER +
      "test('borrows a copy', async () => {})\n" +
      "test('returns the loan', async () => {})\n" +
      "test('lists the catalogue', async () => {})\n")
    return { featureDir, spec }
  }

  const serialKnown = (spec: string, name: string, title: string, line: number) => ({
    name,
    title,
    listLine: `lending.spec.ts › ${title}`,
    location: `${spec}:${line}`,
  })

  it('re-runs the already-passed group members so the failing test can reach the app', () => {
    const { featureDir, spec } = serialFeature()

    const plan = computeVerificationPlan(featureDir, {
      knownTests: [
        serialKnown(spec, 'test-case-borrows-a-copy', 'borrows a copy', 3),
        serialKnown(spec, 'test-case-returns-the-loan', 'returns the loan', 4),
        serialKnown(spec, 'test-case-lists-the-catalogue', 'lists the catalogue', 5),
      ],
      passedNames: ['test-case-borrows-a-copy', 'test-case-lists-the-catalogue'],
      passed: 2,
      failed: [{ name: 'test-case-returns-the-loan' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    if (plan.selection.kind !== 'test-list') return
    // The failed test first, then both passed group-mates — without the borrow
    // test in the list the return test cannot pass however good the fix is.
    expect(plan.selection.testList).toEqual([
      'lending.spec.ts › returns the loan',
      'lending.spec.ts › borrows a copy',
      'lending.spec.ts › lists the catalogue',
    ])
    expect(plan.selection.selected).toBe(3)
    expect(plan.selection.reason).toContain('Also re-running 2 already-passed tests from the same serial spec files')
    // The buckets stay the not-yet-passed set: a companion passing again is not
    // heal progress, and `nonPassedSignatureFromPlan` reads these.
    expect(plan.failedFirst.map((test) => test.name)).toEqual(['test-case-returns-the-loan'])
    expect(plan.skipped).toEqual([])
    expect(plan.pending).toEqual([])
    expect(nonPassedSignatureFromPlan(plan)).toBe('test-case-returns-the-loan')
  })

  it('detects the test.describe.serial spelling too', () => {
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'lending.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test.describe.serial('lending', () => {\n" +
      "  test('borrows a copy', async () => {})\n" +
      "  test('returns the loan', async () => {})\n" +
      '})\n')

    const plan = computeVerificationPlan(featureDir, {
      knownTests: [
        serialKnown(spec, 'test-case-borrows-a-copy', 'borrows a copy', 3),
        serialKnown(spec, 'test-case-returns-the-loan', 'returns the loan', 4),
      ],
      passedNames: ['test-case-borrows-a-copy'],
      passed: 1,
      failed: [{ name: 'test-case-returns-the-loan' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    if (plan.selection.kind !== 'test-list') return
    expect(plan.selection.testList).toContain('lending.spec.ts › borrows a copy')
    expect(plan.selection.reason).toContain('Also re-running 1 already-passed test from the same serial spec file,')
  })

  it('leaves a plain parallel spec targeted at only the not-yet-passed tests', () => {
    // Negative control for the source match: `test.describe(...)` without a
    // serial mode must not widen anything, or every rerun becomes a full suite.
    const featureDir = mkFeatureDir()
    const spec = writeSpec(featureDir, 'lending.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test.describe('lending', () => {\n" +
      "  test('borrows a copy', async () => {})\n" +
      "  test('returns the loan', async () => {})\n" +
      '})\n')

    const plan = computeVerificationPlan(featureDir, {
      knownTests: [
        serialKnown(spec, 'test-case-borrows-a-copy', 'borrows a copy', 3),
        serialKnown(spec, 'test-case-returns-the-loan', 'returns the loan', 4),
      ],
      passedNames: ['test-case-borrows-a-copy'],
      passed: 1,
      failed: [{ name: 'test-case-returns-the-loan' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    if (plan.selection.kind !== 'test-list') return
    expect(plan.selection.testList).toEqual(['lending.spec.ts › returns the loan'])
    expect(plan.selection.reason).not.toContain('serial')
  })

  it('does not widen when the selected tests live outside the serial file', () => {
    const { featureDir } = serialFeature()
    const other = writeSpec(featureDir, 'health.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('serves health', async () => {})\n")

    const plan = computeVerificationPlan(featureDir, {
      knownTests: [
        { name: 'test-case-serves-health', title: 'serves health', listLine: 'health.spec.ts › serves health', location: `${other}:2` },
      ],
      failed: [{ name: 'test-case-serves-health' }],
    })

    expect(plan.kind).toBe('targeted')
    if (plan.kind !== 'targeted') return
    if (plan.selection.kind !== 'test-list') return
    expect(plan.selection.testList).toEqual(['health.spec.ts › serves health'])
  })

  it('treats an unreadable spec as non-serial rather than guessing', () => {
    const featureDir = mkFeatureDir()
    writeUnreadableSpec(featureDir, (good) => {
      const plan = computeVerificationPlan(featureDir, {
        knownTests: [
          { name: 'test-case-still-parses', title: 'still parses', listLine: 'b-good.spec.ts › still parses', location: `${good}:2` },
        ],
        failed: [{ name: 'test-case-still-parses' }],
      })

      expect(plan.kind).toBe('targeted')
    })
  })

  it('runs the full suite when a selected test cannot be placed in a file', () => {
    // Summaries written before the reporter captured locations: membership in
    // the serial group is unprovable, so widening to everything is the only
    // sound answer.
    const { featureDir, spec } = serialFeature()

    const plan = computeVerificationPlan(featureDir, {
      knownTests: [
        serialKnown(spec, 'test-case-borrows-a-copy', 'borrows a copy', 3),
        { name: 'test-case-returns-the-loan', title: 'returns the loan', listLine: 'lending.spec.ts › returns the loan' },
      ],
      passedNames: ['test-case-borrows-a-copy'],
      failed: [{ name: 'test-case-returns-the-loan' }],
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('cannot select the group intact')
  })

  it('runs the full suite on the static-extraction path, which cannot name a group', () => {
    // No `knownTests` at all — the AST fallback targets bare file:line and has
    // no per-test identity to widen with.
    const { featureDir, spec } = serialFeature()

    const plan = computeVerificationPlan(featureDir, {
      passedNames: ['test-case-borrows-a-copy'],
      failed: [{ name: 'test-case-returns-the-loan', location: `${spec}:4` }],
      total: 3,
    })

    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('cannot select the group intact')
  })

  it('runs the full suite on the failed-locations path when extraction finds no tests', () => {
    // A serial spec that declares the mode but holds no `test()` call makes
    // static extraction yield nothing, dropping through to failed-locations
    // targeting — equally unable to reassemble a group.
    const featureDir = mkFeatureDir()
    writeSpec(featureDir, 'lending.spec.ts', SERIAL_HEADER)

    const failed = [{ name: 'test-case-returns-the-loan', location: '/tmp/lending.spec.ts:4' }]

    const plan = computeVerificationPlan(featureDir, { failed, total: 3 })
    expect(plan.kind).toBe('full-suite')
    if (plan.kind !== 'full-suite') return
    expect(plan.reason).toContain('cannot select the group intact')
    expect(plan.total).toBe(3)
    // A summary carrying no total at all falls back to the failure count, so the
    // plan never reports a suite of zero tests.
    expect(computeVerificationPlan(featureDir, { failed })).toMatchObject({ kind: 'full-suite', total: 1 })
  })

  it('still reports all-passed for a serial spec with nothing left to run', () => {
    // The gates sit AFTER each path's all-passed arm on purpose: widening a
    // fully-passed summary would make `decideRunStatus` fail a passing run.
    const { featureDir, spec } = serialFeature()

    expect(computeVerificationPlan(featureDir, {
      knownTests: [serialKnown(spec, 'test-case-borrows-a-copy', 'borrows a copy', 3)],
      passedNames: ['test-case-borrows-a-copy'],
    }).kind).toBe('all-passed')
    // Static-extraction path: every extracted test is in passedNames.
    expect(computeVerificationPlan(featureDir, {
      passedNames: ['test-case-borrows-a-copy', 'test-case-returns-the-loan', 'test-case-lists-the-catalogue'],
    }).kind).toBe('all-passed')
    // Failed-locations path: no failures recorded at all.
    expect(computeVerificationPlan(mkFeatureDir(), { total: 2 }).kind).toBe('all-passed')
  })
})

describe('specFileOfKnownTest', () => {
  it('returns undefined for a test with no location and for a location with no file', () => {
    // Locations come from a summary on disk, so a malformed `:12` is
    // representable even though the reporter never writes one — resolving it
    // would silently name the process cwd as the spec file.
    expect(specFileOfKnownTest({ name: 'a', title: 'a' })).toBeUndefined()
    expect(specFileOfKnownTest({ name: 'a', title: 'a', location: ':12' })).toBeUndefined()
  })
})
