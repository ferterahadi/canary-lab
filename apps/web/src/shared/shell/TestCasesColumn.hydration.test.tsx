// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getFeatureDirtyDiff, getFeatureTests, getFeatureTestsPreview } from '../api/client'
import { readableTest } from '../api/__fixtures__/readable-test'
import fixture from '@/features/runs/utils/__fixtures__/run-snapshot-review.json'
import type { RunManifest, RunSummary } from '../api/types'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'

vi.mock('./use-discovery-repair', () => ({ useDiscoveryRepair: () => ({ repairs: [], start: async () => {}, starting: false, startError: null }) }))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureTests: vi.fn(),
    getFeatureTestsPreview: vi.fn(),
    getFeatureDirtyDiff: vi.fn(),
    getTestSourceComparison: vi.fn().mockResolvedValue({ state: 'ready', files: [], differences: [], changes: { added: [], changed: [], removed: [] } }),
  }
})

vi.mock('shiki/core', () => ({
  createHighlighterCore: async () => ({
    codeToHtml: (code: string) => (
      `<pre class="shiki one-dark-pro"><code>${
        code.split('\n').map((line) => `<span class="line">${line}</span>`).join('\n')
      }</code></pre>`
    ),
  }),
}))

vi.mock('shiki/engine/oniguruma', () => ({ createOnigurumaEngine: () => ({}) }))

vi.mock('shiki/langs/typescript.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-dark-pro.mjs', () => ({ default: {} }))

vi.mock('shiki/themes/one-light.mjs', () => ({ default: {} }))

vi.mock('shiki/wasm', () => ({ default: {} }))

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(getFeatureTests).mockReset()
  vi.mocked(getFeatureTestsPreview).mockReset().mockResolvedValue([])
  vi.mocked(getFeatureDirtyDiff).mockReset().mockResolvedValue({ tests: [] })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('TestCasesColumn', () => {
  it('keeps expanded cases through a failed discovery refresh and recovers without a reload', async () => {
    vi.useFakeTimers()
    const file = '/tmp/features/alpha/e2e/current.spec.ts'
    const test = (name: string) => ({ name, line: 42, bodySource: '', steps: [], readable: readableTest(name) })
    const resolved = [{ file, tests: [test('cannot use GET /a'), test('cannot use GET /b')] }]
    vi.mocked(getFeatureTests).mockResolvedValueOnce(resolved)
      .mockResolvedValueOnce([{ file, tests: [test('cannot use ${operation}')], discoveryError: 'Playwright could not enumerate the test cases.' }])
      .mockResolvedValueOnce([{ file, tests: [...resolved[0].tests, test('new case')] }])
    function View() {
      const { invalidate } = useInvalidation()
      return <>
        <button onClick={() => invalidate('tests')}>Refresh tests</button>
        <TestCasesColumn feature="alpha" />
      </>
    }
    await act(async () => { root.render(<InvalidationProvider><View /></InvalidationProvider>) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button')?.click() })
    expect(container.textContent).toContain('Showing the last list that loaded.')
    expect(container.textContent).toContain('cannot use GET /a')
    expect(container.textContent).toContain('cannot use GET /b')
    expect(container.textContent).not.toContain('${operation}')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(container.textContent).toContain('new case')
    expect(container.textContent).not.toContain('could not enumerate')
  })

  it('bounds discovery retries and offers a manual retry without showing incomplete definitions', async () => {
    vi.useFakeTimers()
    vi.mocked(getFeatureTests).mockResolvedValue([{ file: '/tmp/a.spec.ts', tests: [], discoveryError: 'Discovery unavailable' }])
    await act(async () => { root.render(<TestCasesColumn feature="alpha" />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(getFeatureTests).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Discovery unavailable')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry discovery')
    expect(retry).toBeTruthy()
    await act(async () => { retry?.click() })
    expect(getFeatureTests).toHaveBeenCalledTimes(4)
  })

  it('hydrates selected run summary tests by title when source lines drift', async () => {
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: '/tmp/features/alpha/e2e/current.spec.ts',
        tests: [
          {
            name: 'retrieves a REJECTED record with reason populated',
            line: 396,
            bodySource: "{\n  await page.goto('/line/rejected')\n  await expect(page).toHaveText('REJECTED')\n}",
            steps: [],
            readable: readableTest('retrieves a REJECTED record with reason populated'),
          },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha" runEvidence={{ summary: {
            complete: false,
            total: 1,
            passed: 0,
            passedNames: [],
            failed: [],
            running: {
              name: 'test-case-retrieves-a-rejected-record-with-reason-populated',
              location: '/tmp/features/alpha/e2e/current.spec.ts:396:1',
            },
            knownTests: [
              {
                id: 'test-id-rejected',
                name: 'test-case-retrieves-a-rejected-record-with-reason-populated',
                title: 'retrieves a REJECTED record with reason populated',
                location: '/tmp/features/alpha/e2e/current.spec.ts:393',
              },
            ],
          }, status: 'running' }}
        />,
      )
    })

    const codeTab = container.querySelector<HTMLButtonElement>('[data-testid="test-presentation-code-tab"]')
    expect(codeTab).not.toBeNull()
    await act(async () => {
      codeTab?.click()
    })

    expect(container.textContent).toContain("page.goto('/line/rejected')")
    expect(container.textContent).not.toContain('No test body available.')
  })

  it('uses workspace tests for counts and run summary ids only for statuses', async () => {
    const specFile = '/tmp/features/alpha/e2e/current.spec.ts'
    const knownTests = Array.from({ length: 31 }, (_, idx) => ({
      id: `test-id-${idx + 1}`,
      name: `test-case-run-test-${idx + 1}`,
      title: `run test ${idx + 1}`,
      location: `${specFile}:${idx + 1}`,
    }))
    knownTests[5] = {
      id: 'test-id-duplicate-a',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: `${specFile}:100`,
    }
    knownTests[6] = {
      id: 'test-id-duplicate-b',
      name: 'test-case-validates-duplicate',
      title: 'validates duplicate',
      location: `${specFile}:120`,
    }
    vi.mocked(getFeatureTests).mockResolvedValue([
      {
        file: specFile,
        tests: [
          ...knownTests.slice(0, 5).map((test, idx) => ({
            name: test.title,
            line: idx + 1,
            bodySource: '',
            steps: [],
            readable: readableTest(test.title),
          })),
          { name: 'validates duplicate', line: 100, bodySource: '', steps: [], readable: readableTest('validates duplicate') },
          { name: 'validates duplicate', line: 120, bodySource: '', steps: [], readable: readableTest('validates duplicate') },
          ...knownTests.slice(7, 31).map((test, idx) => ({
            name: test.title,
            line: idx + 8,
            bodySource: '',
            steps: [],
            readable: readableTest(test.title),
          })),
          { name: 'workspace-only test 32', line: 132, bodySource: '', steps: [], readable: readableTest('workspace-only test 32') },
          { name: 'workspace-only test 33', line: 133, bodySource: '', steps: [], readable: readableTest('workspace-only test 33') },
        ],
      },
    ])

    await act(async () => {
      root.render(
        <TestCasesColumn
          feature="alpha" runEvidence={{ summary: {
            complete: false,
            total: 31,
            passed: 12,
            passedNames: [
              ...knownTests.slice(0, 5).map((test) => test.name),
              'test-case-validates-duplicate',
              ...knownTests.slice(7, 13).map((test) => test.name),
            ],
            passedIds: [
              ...knownTests.slice(0, 5).map((test) => test.id),
              'test-id-duplicate-a',
              ...knownTests.slice(7, 13).map((test) => test.id),
            ],
            knownTests,
            failed: [],
          } as any, status: 'aborted' }}
        />,
      )
    })

    expect(container.textContent).toContain('12/33')
    expect(container.textContent).not.toContain('12/31')
    expect(container.textContent).toContain('workspace-only test 33')
    expect(container.textContent).toContain('validates duplicate')
    expect(container.querySelectorAll('.border-success\\/40')).toHaveLength(12)
  })
})

// The anonymized recording keeps all 98 results. Different workspace/snapshot
// roots made every card PENDING after refresh, so both roots are load-bearing.
it('hydrates the recorded snapshot results without confusing them with live source', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue(fixture.specs.map((spec) => ({
    ...spec,
    tests: spec.tests.map((test) => ({ ...test, bodySource: '{}', steps: [], readable: readableTest(test.name) })),
  })))
  await act(async () => {
    root.render(<TestCasesColumn
      feature="sample-suite" runEvidence={{ manifest: fixture.manifest as RunManifest, summary: fixture.summary as RunSummary, status: 'healing' }}
    />)
  })
  const badges = Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').toUpperCase())
  expect(badges.filter((t) => t.endsWith('PASSED'))).toHaveLength(77)
  expect(badges.filter((t) => t.endsWith('FAILED'))).toHaveLength(12)
  expect(badges.filter((t) => t.endsWith('SKIPPED'))).toHaveLength(9)
  expect(badges.filter((t) => t.endsWith('PENDING'))).toHaveLength(0)
  expect(container.textContent).toMatch(/77\s*\/\s*98/)
  // The default view carries no provenance label: a column of recorded statuses
  // already says which version is on screen. Only the exception is marked, and
  // this is not it.
  const header = container.querySelector('.cl-panel-header')
  expect(header?.textContent).not.toContain('Current source')
  expect(container.querySelector('[data-testid="suite-version-menu"]')).toBeNull()
})

it('shows the discovery error on the card and never parsed definitions as a test list', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue([{
    file: '/tmp/features/alpha/e2e/current.spec.ts',
    tests: [{ name: 'cannot use ${operation}', line: 42, bodySource: '', steps: [], readable: readableTest('cannot use ${operation}') }],
    discoveryError: 'Playwright could not enumerate the test cases.',
    discoveryDiagnostics: 'Cannot find module ./fixtures/login',
  }])
  const total = vi.fn()
  await act(async () => root.render(<TestCasesColumn feature="alpha" runEvidence={{ status: 'queued' }} onTotalTestsChange={total} />))
  // The error reads on the card itself, with no disclosure to open first.
  expect(container.querySelector('[data-testid="test-list-error-summary"]')?.textContent).toBe('Cannot find module ./fixtures/login')
  expect(container.querySelectorAll('details')).toHaveLength(0)
  // Definitions recovered by parsing were never the discovered test count, and
  // the card no longer lists them at all — so they cannot be read as one.
  expect(container.textContent).not.toContain('${operation}')
  expect(total).toHaveBeenLastCalledWith(0)
  expect(container.querySelector('[data-testid="test-presentation"]')).toBeNull()
})

it('retains a suite’s last discovered list when returning from another suite after discovery fails', async () => {
  const test = (name: string) => ({ name, line: 42, bodySource: '', steps: [], readable: readableTest(name) })
  vi.mocked(getFeatureTests).mockResolvedValueOnce([{ file: '/alpha/a.spec.ts', tests: [test('resolved alpha')] }])
    .mockResolvedValueOnce([{ file: '/beta/b.spec.ts', tests: [test('resolved beta')] }])
    .mockResolvedValue([{ file: '/alpha/a.spec.ts', tests: [test('${alpha}')], discoveryError: 'Discovery failed' }])
  const render = (feature: string) => act(async () => root.render(<TestCasesColumn feature={feature} />))
  await render('alpha'); await render('beta'); await render('alpha')
  expect(container.textContent).toContain('Showing the last list that loaded.')
  expect(container.textContent).toContain('resolved alpha')
  expect(container.textContent).not.toContain('resolved beta')
  expect(container.textContent).not.toContain('${alpha}')
})

// Names were changed from @req/@variant tags to a sample: prefix after
// this recorded run. Loading workspace source made all 98 results pending.
it('keeps all recorded verdicts when current test names changed', async () => {
  const { default: recorded } = await import('@/features/runs/utils/__fixtures__/run-snapshot-renamed.json')
  const summary = recorded.summary as RunSummary
  const files = new Map<string, { name: string; line: number; bodySource: string; steps: []; readable: ReturnType<typeof readableTest> }[]>()
  for (const test of summary.knownTests!) {
    const match = /^(.*):(\d+)$/.exec(test.location!)!
    const entries = files.get(match[1]) ?? []
    entries.push({ name: test.title!, line: Number(match[2]), bodySource: '{}', steps: [], readable: readableTest(test.title!) })
    files.set(match[1], entries)
  }
  const saved = [...files].map(([file, tests]) => ({ file, tests }))
  vi.mocked(getFeatureTests).mockImplementation(async (_feature, _opts, runId) => runId ? saved : [{
    file: 'current.spec.ts', tests: [{ name: 'sample: renamed current test', line: 1, bodySource: '{}', steps: [], readable: readableTest('current') }],
  }])
  await act(async () => root.render(<TestCasesColumn feature="renamed-suite" runEvidence={{ manifest: recorded.manifest as RunManifest, summary, status: 'failed' }} />))
  expect(getFeatureTests).toHaveBeenCalledWith('renamed-suite', undefined, recorded.manifest.runId)
  const labels = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
  expect(labels.filter((text) => text.endsWith('passed'))).toHaveLength(85)
  expect(labels.filter((text) => text.endsWith('failed'))).toHaveLength(4)
  expect(labels.filter((text) => text.endsWith('skipped'))).toHaveLength(9)
  expect(labels.filter((text) => text.endsWith('pending'))).toHaveLength(0)
  expect(container.textContent).not.toContain('renamed current test')
  expect(container.textContent).toContain('85/98')

  vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(409, { error: 'Snapshot unavailable' }))
  await act(async () => root.render(<TestCasesColumn feature="renamed-suite" runEvidence={{ manifest: { ...recorded.manifest, runId: 'missing' } as RunManifest, summary, status: 'failed' }} />))
  expect(container.textContent).toContain('Recorded tests unavailable')
  expect(container.textContent).not.toContain(summary.knownTests![0].title!)
  expect(container.textContent).not.toContain('Repair in Canary Lab')
  expect(container.textContent).toContain('Snapshot unavailable')
  expect(container.textContent).toContain('Reload recorded tests')
  expect(container.textContent).not.toContain('Retry discovery')
})

it('loads the recorded roster when it arrives after the run booted', async () => {
  const manifest = { runId: 'booting-run', featureDir: '/workspace/features/suite', suiteSnapshot: { kind: 'taken', dir: '/workspace/logs/runs/booting-run/suite', takenAt: '', digest: '' } } as RunManifest
  vi.mocked(getFeatureTests).mockResolvedValueOnce([])
  await act(async () => root.render(<TestCasesColumn feature="suite" runEvidence={{ manifest, status: 'running' }} />))
  expect(container.querySelector('[data-testid="tests-run-listing"]')?.textContent).toBe('Listing tests…')
  const name = 'recorded test'
  const file = `${manifest.suiteSnapshot!.kind === 'taken' ? manifest.suiteSnapshot!.dir : ''}/e2e/a.spec.ts`
  vi.mocked(getFeatureTests).mockResolvedValue([{ file, tests: [{ name, line: 1, bodySource: '{}', steps: [], readable: readableTest(name) }] }])
  const summary: RunSummary = { complete: false, total: 1, passed: 0, failed: [], passedIds: [], knownTests: [{ id: 'one', name: 'test-case-recorded-test', title: name, location: `${file}:1` }] }
  await act(async () => root.render(<TestCasesColumn feature="suite" runEvidence={{ manifest, summary, status: 'running' }} />))
  expect(container.textContent).not.toContain('Recorded tests unavailable')
  expect(container.textContent).toContain(name)
  expect(getFeatureTests).toHaveBeenCalledTimes(2)
})

it('shows the 23 recorded legacy passes without offering current source as evidence', async () => {
  const { default: legacy } = await import('@/features/runs/utils/__fixtures__/run-legacy-roster.json')
  const summary = legacy.summary as RunSummary
  const specs = summary.knownTests!.map((known) => {
    const [, file, line] = /^(.*?):(\d+)$/.exec(known.location!)!
    return { file, recordedSourceUnavailable: true, tests: [{ name: known.title!, line: Number(line), bodySource: '', steps: [], readable: readableTest(known.title!) }] }
  })
  vi.mocked(getFeatureTests).mockResolvedValue(specs)
  await act(async () => root.render(<TestCasesColumn feature={legacy.manifest.feature} runEvidence={{ manifest: legacy.manifest as RunManifest, summary, status: 'passed' }} />))
  expect(container.textContent).toContain('23/23')
  expect([...container.querySelectorAll('button')].filter((button) => button.textContent?.endsWith('passed'))).toHaveLength(23)
  // One statement of the fact, on the card it is about. The banner that used
  // to repeat it above the list is gone.
  expect(container.textContent).not.toContain('Source wasn’t saved for some tests in this run')
  expect(container.textContent).toContain('Source was not retained for this test')
  expect(container.textContent).not.toContain('Recorded tests unavailable')
  expect(container.textContent).not.toContain('Retry discovery')
  expect(container.querySelector('[aria-label="Open in editor"]')).toBeNull()
})

it('explains an aborted run with no roster without inviting discovery retries', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue([])
  const manifest = { runId: 'aborted-before-start', featureDir: '/workspace/features/suite' } as RunManifest
  await act(async () => root.render(<TestCasesColumn feature="suite" runEvidence={{ manifest, status: 'aborted' }} />))
  expect(container.querySelector('[data-testid="tests-run-none"]')?.textContent).toBe('This run recorded no tests')
  expect(container.textContent).not.toContain('Retry discovery')
  expect(container.textContent).not.toContain('No tests in this suite yet')
  expect(container.textContent).not.toContain('HTTP 409')
})

it('lets an empty historical run open current tests without inheriting its verdicts', async () => {
  vi.mocked(getFeatureTests).mockImplementation(async (_feature, _opts, runId) => runId ? [] : [{
    file: '/workspace/features/suite/e2e/current.spec.ts',
    tests: [{ name: 'current test', line: 1, bodySource: 'expect(200).toBe(200)', steps: [], readable: readableTest('current test') }],
  }])
  const manifest = { runId: 'old-run', featureDir: '/workspace/features/suite' } as RunManifest
  function View() {
    const [current, setCurrent] = useState(false)
    return <TestCasesColumn feature="suite" currentTests={current} onCurrentTestsChange={setCurrent} runEvidence={{ manifest, status: 'aborted' }} />
  }
  await act(async () => root.render(<View />))
  expect(container.querySelector('[data-testid="tests-run-none"]')).not.toBeNull()
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll('button'), ...document.querySelectorAll('[role="menu"] button')]
      .find((button) => button.getAttribute('aria-label')?.startsWith(label))
    expect(button).toBeTruthy()
    ;(button as HTMLButtonElement).click()
  })
  // Even an empty recorded run keeps the visible source choice.
  expect(container.querySelector('[aria-label="Test source"]')).not.toBeNull()
  await click('Current source')
  expect(getFeatureTests).toHaveBeenLastCalledWith('suite', undefined, undefined)
  expect(container.textContent).toContain('current test')
  expect(container.querySelector('[aria-label^="Current source"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(0)
  expect(container.querySelector('[data-testid="suite-version-menu"]')).toBeNull()
  await click('Recorded run')
  expect(getFeatureTests).toHaveBeenLastCalledWith('suite', undefined, 'old-run')
  expect(container.querySelector('[data-testid="tests-run-none"]')).not.toBeNull()
  expect(container.textContent).not.toContain('expect(200)')
  expect(container.querySelector('[aria-label="Test source"]')).not.toBeNull()
})

it('keeps switching reversible when the saved suite and current source are identical', async () => {
  const manifest = { runId: 'r1', featureDir: '/tmp/suite', suiteSnapshot: { kind: 'taken' as const, dir: '/tmp/runs/r1/suite', takenAt: 'now', digest: 'same' } }
  const name = 'same test'
  vi.mocked(getFeatureTests).mockImplementation(async (_feature, _signal, runId) => [{
    file: `${runId ? manifest.suiteSnapshot.dir : manifest.featureDir}/e2e/a.spec.ts`,
    tests: [{ name, line: 1, bodySource: '', steps: [], readable: readableTest(name) }],
  }])
  function View() {
    const [source, setSource] = useState(false)
    return <TestCasesColumn feature="suite" currentTests={source} onCurrentTestsChange={setSource}
      runEvidence={{ manifest, summary: { complete: true, total: 1, passed: 1, passedNames: ['test-case-same-test'], failed: [] }, status: 'passed' }}
      comparisonBaseline={{ manifest }} />
  }
  await act(async () => root.render(<View />))
  for (const label of ['Current source', 'Recorded run', 'Current source']) {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Test source"] button')]
    // Each tab's accessible name carries its counts after the colon; the name
    // before it is what identifies the tab.
    expect(buttons.map((button) => button.getAttribute('aria-label')?.split(':')[0])).toEqual(['Current source', 'Recorded run'])
    const button = buttons.find((button) => button.getAttribute('aria-label')?.startsWith(label))!
    await act(async () => button.click())
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-testid="suite-version-menu"]')).toBeNull()
    expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(label === 'Recorded run' ? 1 : 0)
  }
})

it('offers current source from a legacy run while keeping its results in recorded mode', async () => {
  const { default: legacy } = await import('@/features/runs/utils/__fixtures__/run-legacy-roster.json')
  const known = legacy.summary.knownTests[0]
  const [, file, line] = /^(.*?):(\d+)$/.exec(known.location!)!
  vi.mocked(getFeatureTests).mockImplementation(async (_feature, _signal, runId) => [{
    file, ...(runId ? { recordedSourceUnavailable: true } : {}),
    tests: [{ name: known.title!, line: Number(line), bodySource: '', steps: [], readable: readableTest(known.title!) }],
  }])
  function View() {
    const [current, setCurrent] = useState(false)
    return <TestCasesColumn feature={legacy.manifest.feature} currentTests={current} onCurrentTestsChange={setCurrent} runEvidence={{ manifest: legacy.manifest as RunManifest, summary: legacy.summary as RunSummary, status: 'passed' }} />
  }
  await act(async () => root.render(<View />))
  expect(container.querySelector('.cl-card')?.textContent).toContain('passed')
  // The way across is the header's own source tab — the card never grew a
  // second control that did the same thing.
  const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label')?.startsWith('Current source'))!
  await act(async () => action.click())
  expect(container.textContent).not.toContain('Source was not retained')
  expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(0)
})
