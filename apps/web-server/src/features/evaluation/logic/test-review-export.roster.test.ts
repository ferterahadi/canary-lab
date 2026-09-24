import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildEvaluationLlmPrompt, buildTestReviewPacket, createAssertionExport, createAssertionHtml, createEvaluationExport, createEvaluationHtml, evaluationCodexArgs, statusBucket, testStatusCounts, NOT_RUN_STATUS } from './test-review-export'
import type { RunDetail, PlaywrightPlaybackEvent } from '../../runs/logic/run-store'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// The report's central promise: it lists every test the feature DECLARED, and
// says plainly which of them the run never reached. A run that stops at the
// failure limit must not shrink the suite it reports on.
describe('declared-test roster', () => {
  let spec: string

  function rosterDetail(overrides: Partial<RunDetail> = {}): RunDetail {
    return {
      runId: 'run-roster',
      manifest: {
        runId: 'run-roster',
        feature: 'checkout',
        featureDir: tmpDir,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:09.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      },
      summary: {
        complete: true,
        total: 12,
        passed: 3,
        passedNames: ['test-case-ran-and-passed', 'test-case-passed-by-name'],
        passedIds: ['id-pass', 'id-pass-2'],
        skippedIds: ['id-skip'],
        skippedNames: ['test-case-skipped-by-name'],
        failed: [
          { id: 'id-fail', name: 'test-case-ran-and-failed', error: { message: 'boom', snippet: '> 12 | expect(x)' } },
          { id: 'id-fail-2', name: 'test-case-failed-no-playback' },
          { name: 'test-case-failed-by-name', error: { message: 'named failure  ' } },
        ],
        knownTests: [
          { id: 'id-pass', name: 'test-case-ran-and-passed', title: '@req-R1 @path-happy ran and passed', location: `${spec}:3` },
          { id: 'id-fail', name: 'test-case-ran-and-failed', title: 'ran and failed', location: `${spec}:7` },
          { id: 'id-stop', name: 'test-case-interrupted', title: 'interrupted mid-flight', location: `${spec}:11` },
          { id: 'id-fail-2', name: 'test-case-failed-no-playback', title: 'failed without playback', location: `${spec}:15` },
          { name: 'test-case-failed-by-name', title: 'failed by name' },
          { id: 'id-skip', name: 'test-case-skipped-by-id', title: 'skipped by id' },
          { name: 'test-case-skipped-by-name', title: 'skipped by name' },
          { id: 'id-pass-2', name: 'test-case-passed-by-id', title: 'passed by id' },
          { name: 'test-case-passed-by-name', title: 'passed by name' },
          // No title: the roster falls back to the test's name.
          { id: 'id-never', name: 'test-case-never-reached' },
          // A malformed location must not break the per-spec grouping.
          { id: 'id-never-2', name: 'test-case-also-never-reached', title: 'also never reached', location: '/:12' },
          // A title made only of coverage annotations still has to render as
          // something — the tags are stripped for display.
          { id: 'id-never-3', name: 'test-case-tags-only', title: '@req-R9' },
        ],
      },
      playbackEvents: [
        {
          type: 'test-end',
          time: '2026-01-01T00:00:05.000Z',
          test: { id: 'id-pass', name: 'test-case-ran-and-passed', title: '@req-R1 @path-happy ran and passed', location: `${spec}:3` },
          status: 'passed',
          passed: true,
          durationMs: 120,
          retry: 0,
        },
        {
          type: 'test-end',
          time: '2026-01-01T00:00:06.000Z',
          test: { id: 'id-fail', name: 'test-case-ran-and-failed', title: 'ran and failed', location: `${spec}:7` },
          status: 'failed',
          passed: false,
          durationMs: 90,
          retry: 0,
          error: { message: 'boom from playback', snippet: '> 8 | expect(y)' },
        },
        {
          type: 'test-end',
          time: '2026-01-01T00:00:07.000Z',
          test: { id: 'id-stop', name: 'test-case-interrupted', title: 'interrupted mid-flight', location: `${spec}:11` },
          status: 'interrupted',
          passed: false,
          durationMs: 40,
          retry: 0,
        },
      ],
      ...overrides,
    } as RunDetail
  }

  beforeEach(() => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    spec = path.join(e2e, 'checkout.spec.ts')
    fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'\n\ntest('ran and passed', async () => {\n  expect(1).toBe(1)\n})\n`)
  })

  it('lists every declared test and marks the ones the run never reached', () => {
    const packet = buildTestReviewPacket(rosterDetail())

    expect(packet.tests).toHaveLength(12)
    expect(packet.tests.map((test) => [test.title, test.status])).toEqual([
      ['@req-R1 @path-happy ran and passed', 'passed'],
      ['ran and failed', 'failed'],
      ['interrupted mid-flight', 'interrupted'],
      ['failed without playback', 'failed'],
      ['failed by name', 'failed'],
      ['skipped by id', 'skipped'],
      ['skipped by name', 'skipped'],
      ['passed by id', 'passed'],
      ['passed by name', 'passed'],
      ['test-case-never-reached', NOT_RUN_STATUS],
      ['also never reached', NOT_RUN_STATUS],
      ['@req-R9', NOT_RUN_STATUS],
    ])
    // A never-run test carries no evidence — not an empty pass.
    expect(packet.tests[9].assertions[0].rationale).toBe('This test was never executed, so the run produced no evidence for it.')
    // Counts stay read from the summary, never re-derived as total - failed.
    expect(packet.passed).toBe(3)
    expect(packet.total).toBe(12)
  })

  it('splits the run into buckets that add up to the declared total', () => {
    const packet = buildTestReviewPacket(rosterDetail())

    expect(testStatusCounts(packet.tests)).toEqual({ passed: 3, failed: 3, interrupted: 1, skipped: 2, notRun: 3 })
    const counts = testStatusCounts(packet.tests)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(packet.tests.length)
  })

  it('prefers the playback verdict over the summary lists', () => {
    const detailWithConflict = rosterDetail()
    // The same test appears as passed in the summary while playback recorded a
    // failure — the per-test verdict wins, and nothing rounds up to a pass.
    detailWithConflict.summary!.passedNames = [...detailWithConflict.summary!.passedNames!, 'test-case-ran-and-failed']
    const packet = buildTestReviewPacket(detailWithConflict)

    expect(packet.tests.find((test) => test.name === 'test-case-ran-and-failed')?.status).toBe('failed')
  })

  it('resolves a summary-only conflict downward rather than up', () => {
    const conflicted = rosterDetail({ playbackEvents: [] })
    conflicted.summary!.passedNames = ['test-case-failed-by-name']
    const packet = buildTestReviewPacket(conflicted)

    expect(packet.tests.find((test) => test.name === 'test-case-failed-by-name')?.status).toBe('failed')
  })

  it('lists a test the roster recorded twice once', () => {
    const twice = rosterDetail()
    // Same id, same location: one test written twice, not two tests.
    twice.summary!.knownTests = [twice.summary!.knownTests![0], twice.summary!.knownTests![0], ...twice.summary!.knownTests!.slice(1)]
    const packet = buildTestReviewPacket(twice)

    expect(packet.tests.filter((test) => test.name === 'test-case-ran-and-passed')).toHaveLength(1)
    expect(packet.tests).toHaveLength(12)
  })

  it('keeps reported tests the roster somehow missed', () => {
    const withExtra = rosterDetail()
    withExtra.summary!.knownTests = withExtra.summary!.knownTests!.slice(0, 1)
    withExtra.summary!.passedNames = ['test-case-summary-only']
    const packet = buildTestReviewPacket(withExtra)

    expect(packet.tests.map((test) => test.name)).toEqual([
      'test-case-ran-and-passed',
      'test-case-ran-and-failed',
      'test-case-interrupted',
      'test-case-summary-only',
    ])
  })

  it('falls back to the executed set for runs recorded before knownTests existed', () => {
    const legacy = rosterDetail()
    delete legacy.summary!.knownTests
    const packet = buildTestReviewPacket(legacy)

    expect(packet.tests.map((test) => test.name)).toEqual([
      'test-case-ran-and-passed',
      'test-case-ran-and-failed',
      'test-case-interrupted',
      'test-case-passed-by-name',
    ])
  })

  it('renders the never-ran block, the failure reason and the result map', async () => {
    const html = await createEvaluationHtml(rosterDetail())

    // The headline a reader needs before reading a single pass ratio.
    expect(html).toContain('<span class="notice-badge">Incomplete run</span>')
    expect(html).toContain('<strong>3 of 12 declared tests never ran.</strong>')
    expect(html).toContain('3 of the 12 declared scenarios never ran, so they are neither passing nor failing evidence.')
    expect(html).toContain('This test was declared but never executed in this run.')
    expect(html).toContain('data-status="notRun"')
    expect(html).toContain('<span class="legend-value">1</span>')
    expect(html).toContain('<span class="legend-label">Interrupted</span>')

    // Failures carry their reason; the code frame only appears when there is one.
    expect(html).toContain('<h3>Why it failed</h3>')
    expect(html).toContain('boom')
    expect(html).toContain('&gt; 12 | expect(x)')
    expect(html).toContain('<pre class="failure-message">named failure</pre>')

    // Navigation: grouped by spec file, with a per-test result map.
    expect(html).toContain('<span class="spec-name">checkout.spec.ts</span>')
    expect(html).toContain('<span class="spec-name">Other tests</span>')
    expect(html).toContain('<span class="spec-name">/</span>')
    expect(html).toContain('data-matrix-cell')
    expect(html).toContain('never ran')

    // Annotation tags are lifted out of the headline and shown as tags.
    expect(html).toContain('<span class="tag">@req-R1</span>')
    expect(html).toContain('<span class="tag">@path-happy</span>')
    expect(html).toContain('<span class="case-title">Ran and passed</span>')
    expect(html).toContain('<span class="case-title">@req-R9</span>')
  })

  it('offers light, system and dark themes without a network round-trip', async () => {
    const html = await createEvaluationHtml(rosterDetail())

    expect(html).toContain('data-theme-set="light"')
    expect(html).toContain('data-theme-set="auto"')
    expect(html).toContain('data-theme-set="dark"')
    // The stored choice is applied before first paint, so dark-mode readers
    // never get a white flash.
    expect(html).toContain("localStorage.getItem('canary-evaluation-theme')")
    expect(html.indexOf('canary-evaluation-theme')).toBeLessThan(html.indexOf('<body>'))
    // Both palettes ship; neither is fetched.
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).not.toMatch(/<link[^>]+href="https?:/)
    expect(html).not.toMatch(/@import\s+url\(/)
  })

  it('re-attaches a rewrite written before never-run tests were listed', async () => {
    const stored = {
      featureTitle: 'Checkout Safeguards',
      // Written when the report only showed executed tests: the three playback
      // entries in playback order, then the summary-only passes the old builder
      // appended. Rebuilding that order is what lets each case find its test.
      summary: 'Of the five scenarios shown here, one passed.',
      cases: [
        { title: 'A shopper checks out', whatWasChecked: 'Checked A.', whyItMatters: 'Matters A.', confidence: 'High.' },
        { title: 'A declined card is refused', whatWasChecked: 'Checked B.', whyItMatters: 'Matters B.', confidence: 'Low.' },
        { title: 'A slow gateway stops the run', whatWasChecked: 'Checked C.', whyItMatters: 'Matters C.', confidence: 'Low.' },
        { title: 'A summary-only pass', whatWasChecked: 'Checked D.', whyItMatters: 'Matters D.', confidence: 'Low.' },
        { title: 'A pass known only by name', whatWasChecked: 'Checked E.', whyItMatters: 'Matters E.', confidence: 'Low.' },
      ],
    }
    const html = await createEvaluationHtml(rosterDetail(), { rewrite: stored })

    // Authored wording survives, still attached to the test it was written about.
    expect(html).toContain('<h1>Checkout Safeguards</h1>')
    expect(html).toContain('<span class="case-title">A shopper checks out</span>')
    expect(html).toContain('<span class="case-title">A declined card is refused</span>')
    expect(html).toContain('Checked C.')
    expect(html).toContain('<span class="case-title">A pass known only by name</span>')
    // The stale run-level claim does not: it described a 5-scenario report.
    expect(html).not.toContain('Of the five scenarios shown here')
    expect(html).toContain('Checkout Safeguards was evaluated with 12 scenarios.')
  })

  it('rebuilds the legacy order without double-counting a pass it already listed', async () => {
    const detailWithSlugMatch = rosterDetail()
    // The old builder skipped a `passedNames` entry whose slug already matched a
    // playback title, so the rebuilt order has to skip it too — one case off and
    // every authored case attaches to the wrong test.
    detailWithSlugMatch.summary!.passedNames = ['test-case-ran-and-failed', 'test-case-passed-by-name']
    const html = await createEvaluationHtml(detailWithSlugMatch, {
      rewrite: {
        summary: 'Stale.',
        cases: [
          { title: 'Legacy one', whatWasChecked: 'a', whyItMatters: 'b', confidence: 'c' },
          { title: 'Legacy two', whatWasChecked: 'd', whyItMatters: 'e', confidence: 'f' },
          { title: 'Legacy three', whatWasChecked: 'g', whyItMatters: 'h', confidence: 'i' },
          { title: 'Legacy four', whatWasChecked: 'j', whyItMatters: 'k', confidence: 'l' },
        ],
      },
    })

    expect(html).toContain('<span class="case-title">Legacy one</span>')
    expect(html).toContain('<span class="case-title">Legacy four</span>')
  })

  it('leaves a rewrite alone when it matches neither the roster nor the executed set', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: { summary: 'Mismatched.', cases: [{ title: 'Only one', whatWasChecked: 'x', whyItMatters: 'y', confidence: 'z' }] },
    })

    // Unmappable → deterministic wording rather than a guessed alignment.
    expect(html).not.toContain('Only one')
    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })

  it('widens a rewrite that carries no feature title', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: {
        summary: 'Stale summary.',
        cases: [
          { title: 'First', whatWasChecked: 'a', whyItMatters: 'b', confidence: 'c' },
          { title: 'Second', whatWasChecked: 'd', whyItMatters: 'e', confidence: 'f' },
          { title: 'Third', whatWasChecked: 'g', whyItMatters: 'h', confidence: 'i' },
          { title: 'Fourth', whatWasChecked: 'j', whyItMatters: 'k', confidence: 'l' },
          { title: 'Fifth', whatWasChecked: 'm', whyItMatters: 'n', confidence: 'o' },
        ],
      },
    })

    expect(html).toContain('<h1>Checkout</h1>')
    expect(html).toContain('<span class="case-title">First</span>')
    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })

  it('ignores a rewrite that is not shaped like one', async () => {
    const html = await createEvaluationHtml(rosterDetail(), {
      rewrite: { summary: 'No cases array.' } as never,
    })

    expect(html).toContain('Checkout was evaluated with 12 scenarios.')
  })
})

describe('status buckets', () => {
  it('places every recorded status in exactly one bucket', () => {
    expect(statusBucket('passed')).toBe('passed')
    expect(statusBucket('skipped')).toBe('skipped')
    expect(statusBucket(NOT_RUN_STATUS)).toBe('notRun')
    expect(statusBucket('interrupted')).toBe('interrupted')
    // Anything else Playwright can report (failed, timedOut, …) counts as a
    // failure — never as a pass.
    expect(statusBucket('timedOut')).toBe('failed')
    expect(statusBucket('failed')).toBe('failed')
  })
})

// A heal cycle may edit the spec (the agent's "the test is provably wrong"
// exception), which moves every later test onto a new line — and the reporter
// mints a fresh id from that line, so one test carries two ids inside one run.
// The fixture is the recorded evidence of run 2026-09-04T0638-7rcl: the third
// test failed twice at :192, the spec grew by ten lines, and it passed at :202;
// the first two tests only ever ran at :149/:178 and a targeted rerun never
// re-listed them. The report has to say what the run summary and the Playwright
// tab say — three tests, three passed — not four tests with a phantom failure.
describe('a test that moved lines between heal cycles', () => {
  const fixtureDir = path.join(__dirname, '__fixtures__', 'heal-line-shift')
  const warmName = 'test-case-warm-inbounds-stay-inside-the-budget-across-five-samples'

  function readFixture<T>(name: string): T {
    return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf-8').replaceAll('<featureDir>', tmpDir)) as T
  }

  function lineShiftDetail(): RunDetail {
    return {
      runId: '2026-09-04T0638-7rcl',
      manifest: {
        runId: '2026-09-04T0638-7rcl',
        feature: 'cns_inbound_latency_budget',
        featureDir: tmpDir,
        startedAt: '2026-09-04T06:38:01.526Z',
        endedAt: '2026-09-04T06:42:45.417Z',
        status: 'passed',
        healCycles: 2,
        services: [],
      },
      summary: readFixture<RunDetail['summary']>('e2e-summary.json'),
      playbackEvents: readFixture<PlaywrightPlaybackEvent[]>('playwright-events.json'),
    } as RunDetail
  }

  beforeEach(() => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    // Every test here sits on a line the run never recorded (149, 178, 192,
    // 202), so a body can only be found by title — which is the point.
    fs.writeFileSync(path.join(e2e, 'cns-inbound-latency-budget.spec.ts'), [
      "import { test, expect } from '@playwright/test'",
      '',
      "test.describe('inbound-to-Host latency budget', () => {",
      "  test('the budget is declared before anything is measured', async () => {",
      '    expect(500).toBeGreaterThan(0)',
      '  })',
      "  test('a COLD inbound reaches the Host inside the budget', async () => {",
      '    expect(1).toBeLessThanOrEqual(10_000)',
      '  })',
      "  test('warm inbounds stay inside the budget across five samples', async () => {",
      '    expect(493).toBeLessThanOrEqual(500)',
      '  })',
      '})',
      '',
    ].join('\n'))
  })

  it('folds every attempt onto the one declared test and keeps the last verdict', () => {
    const packet = buildTestReviewPacket(lineShiftDetail())

    expect(packet.tests.map((test) => [test.title, test.status])).toEqual([
      ['the budget is declared before anything is measured', 'passed'],
      ['a COLD inbound reaches the Host inside the budget', 'passed'],
      ['warm inbounds stay inside the budget across five samples', 'passed'],
    ])
    expect(testStatusCounts(packet.tests)).toEqual({ passed: 3, failed: 0, interrupted: 0, skipped: 0, notRun: 0 })
    // The surviving attempt is the last one to end, not the first key seen.
    const warm = packet.tests[2]
    expect(warm.location?.endsWith('cns-inbound-latency-budget.spec.ts:202')).toBe(true)
    expect(warm.durationMs).toBe(1492)
    expect(warm.error).toBeUndefined()
  })

  it('finds each test body by title when the recorded line is stale', () => {
    const packet = buildTestReviewPacket(lineShiftDetail())

    expect(packet.tests.map((test) => test.testBody.includes('expect('))).toEqual([true, true, true])
    expect(packet.tests.map((test) => test.assertions[0]?.rationale)).not.toContain(
      'No playback event or source match was available for this passed test.',
    )
  })

  it('keeps two declared tests that share a title in one file apart by line', () => {
    const dup = path.join(tmpDir, 'e2e', 'dup.spec.ts')
    fs.writeFileSync(dup, [
      "import { test, expect } from '@playwright/test'",
      '',
      "test.describe('guest', () => {",
      "  test('renders', async () => {",
      '    expect(1).toBe(1)',
      '  })',
      '})',
      '',
      "test.describe('host', () => {",
      "  test('renders', async () => {",
      '    expect(2).toBe(2)',
      '  })',
      '})',
      '',
    ].join('\n'))
    const detail = lineShiftDetail()
    detail.summary = {
      complete: true,
      total: 2,
      passed: 1,
      passedNames: ['test-case-renders'],
      passedIds: ['id-guest'],
      failed: [{ id: 'id-host', name: 'test-case-renders', location: `${dup}:10` }],
      knownTests: [
        { id: 'id-guest', name: 'test-case-renders', title: 'renders', location: `${dup}:4` },
        { id: 'id-host', name: 'test-case-renders', title: 'renders', location: `${dup}:10` },
      ],
    }
    detail.playbackEvents = [
      { type: 'test-end', time: '2026-01-01T00:00:01.000Z', test: { name: 'test-case-renders', title: 'renders', location: `${dup}:4` }, status: 'passed', passed: true, durationMs: 5, retry: 0 },
      { type: 'test-end', time: '2026-01-01T00:00:02.000Z', test: { name: 'test-case-renders', title: 'renders', location: `${dup}:10` }, status: 'failed', passed: false, durationMs: 6, retry: 0 },
      // A third 'renders' at a line neither declared test owns: with two
      // candidates the line has to decide, and it matches neither, so this is
      // reported evidence the roster lacks — appended, never folded into one
      // of the two.
      { type: 'test-end', time: '2026-01-01T00:00:03.000Z', test: { name: 'test-case-renders', title: 'renders', location: `${dup}:16` }, status: 'passed', passed: true, durationMs: 7, retry: 0 },
    ]

    const packet = buildTestReviewPacket(detail)

    expect(packet.tests.map((test) => [test.location, test.status, test.testBody.includes('expect(1)'), test.testBody.includes('expect(2)')])).toEqual([
      [`${dup}:4`, 'passed', true, false],
      [`${dup}:10`, 'failed', false, true],
      [`${dup}:16`, 'passed', false, false],
    ])
  })

  it('keeps the attempt that ended last, not the line that was reported last', () => {
    // A heal that reverts a spec edit moves the test back to its old line, so the
    // old line's key is refreshed after the new line's: :192 fails, :202 passes,
    // then :192 passes again. Key order says :202 is newest; the clock says :192.
    const spec = path.join(tmpDir, 'e2e', 'cns-inbound-latency-budget.spec.ts')
    const detail = lineShiftDetail()
    const attempt = (line: number, time: string, passed: boolean): PlaywrightPlaybackEvent => ({
      type: 'test-end',
      time,
      test: { name: warmName, title: 'warm inbounds stay inside the budget across five samples', location: `${spec}:${line}` },
      status: passed ? 'passed' : 'failed',
      passed,
      durationMs: 1,
      retry: 0,
    })
    detail.playbackEvents = [
      attempt(192, '2026-09-04T06:38:21.739Z', false),
      attempt(202, '2026-09-04T06:40:38.914Z', true),
      attempt(192, '2026-09-04T06:42:45.032Z', true),
    ]

    const packet = buildTestReviewPacket(detail)

    expect(packet.tests.filter((test) => test.name === warmName).map((test) => [test.status, test.location?.slice(-4)])).toEqual([['passed', ':192']])
  })

  it('keeps roster-less attempts apart when the spec no longer says how many tests share the title', () => {
    const detail = lineShiftDetail()
    detail.summary = { complete: true, total: 1, passed: 1, passedNames: [warmName], failed: [] }
    detail.playbackEvents = detail.playbackEvents!.filter((event) => event.type === 'test-end' && event.test.name === warmName)
    fs.rmSync(path.join(tmpDir, 'e2e', 'cns-inbound-latency-budget.spec.ts'))

    const packet = buildTestReviewPacket(detail)

    // Two lines could be one moved test or two same-titled tests; with nothing
    // to count against, neither is dropped.
    expect(packet.tests.map((test) => [test.status, test.location?.slice(-4)])).toEqual([['failed', ':192'], ['passed', ':202']])
  })

  it('folds a moved test on a run recorded before the roster existed', () => {
    const detail = lineShiftDetail()
    detail.summary = { complete: true, total: 1, passed: 1, passedNames: [warmName], failed: [] }
    detail.playbackEvents = detail.playbackEvents!.filter((event) => event.type === 'test-end' && event.test.name === warmName)

    const packet = buildTestReviewPacket(detail)

    expect(packet.tests.map((test) => [test.status, test.location?.slice(-4)])).toEqual([['passed', ':202']])
  })
})
