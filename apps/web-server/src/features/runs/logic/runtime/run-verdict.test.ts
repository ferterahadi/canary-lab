import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'
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
