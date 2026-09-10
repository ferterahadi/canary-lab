// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getFeatureDirtyDiff, getFeatureTests } from '../api/client'
import { readableTest } from '../api/__fixtures__/readable-test'
import fixture from '@/features/runs/utils/__fixtures__/cns-wa-snapshot.json'
import type { RunManifest, RunSummary } from '../api/types'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'

vi.mock('./use-discovery-repair', () => ({ useDiscoveryRepair: () => ({ repairs: [], start: async () => {}, starting: false, error: null }) }))

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    getFeatureTests: vi.fn(),
    getFeatureDirtyDiff: vi.fn(),
    getTestFileDifference: vi.fn().mockResolvedValue({ changed: false }),
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
        <TestCasesColumn feature="alpha" activeRunStatus={undefined} activeRunSummary={undefined} />
      </>
    }
    await act(async () => { root.render(<InvalidationProvider><View /></InvalidationProvider>) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button')?.click() })
    expect(container.textContent).toContain('Showing the previous test list')
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
    await act(async () => { root.render(<TestCasesColumn feature="alpha" activeRunStatus={undefined} activeRunSummary={undefined} />) })
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
          feature="alpha"
          activeRunStatus="running"
          activeRunSummary={{
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
          }}
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
          feature="alpha"
          activeRunStatus="aborted"
          activeRunSummary={{
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
          } as any}
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

// Recorded from 2026-09-07T0406-r8vx: all 98 tests had results, but the
// workspace/snapshot root difference made every card PENDING after refresh.
it('hydrates the recorded snapshot results without confusing them with live source', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue(fixture.specs.map((spec) => ({
    ...spec,
    tests: spec.tests.map((test) => ({ ...test, bodySource: '{}', steps: [], readable: readableTest(test.name) })),
  })))
  await act(async () => {
    root.render(<TestCasesColumn
      feature="cns-wa"
      activeRunStatus="healing"
      activeRunManifest={fixture.manifest as RunManifest}
      activeRunSummary={fixture.summary as RunSummary}
    />)
  })
  const badges = Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').toUpperCase())
  expect(badges.filter((t) => t.endsWith('PASSED'))).toHaveLength(77)
  expect(badges.filter((t) => t.endsWith('FAILED'))).toHaveLength(12)
  expect(badges.filter((t) => t.endsWith('SKIPPED'))).toHaveLength(9)
  expect(badges.filter((t) => t.endsWith('PENDING'))).toHaveLength(0)
  expect(container.textContent).toMatch(/77\s*\/\s*98/)
  expect(container.textContent).toContain('Selected run')
})

it('shows discovery diagnostics and incomplete definitions without presenting them as test results', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue([{
    file: '/tmp/features/alpha/e2e/current.spec.ts',
    tests: [{ name: 'cannot use ${operation}', line: 42, bodySource: '', steps: [], readable: readableTest('cannot use ${operation}') }],
    discoveryError: 'Playwright could not enumerate the test cases.',
    discoveryDiagnostics: 'Cannot find module ./fixtures/login',
  }])
  const total = vi.fn()
  await act(async () => root.render(<TestCasesColumn feature="alpha" activeRunStatus="queued" activeRunSummary={undefined} onTotalTestsChange={total} />))
  expect(container.textContent).toContain('View discovery error')
  expect(container.textContent).toContain('Cannot find module ./fixtures/login')
  expect(container.textContent).toContain('Source definitions · incomplete')
  expect(container.textContent).toContain('cannot use ${operation}')
  expect(total).toHaveBeenLastCalledWith(0)
  expect(container.querySelector('[data-testid="test-presentation"]')).toBeNull()
})

it('retains a suite’s last discovered list when returning from another suite after discovery fails', async () => {
  const test = (name: string) => ({ name, line: 42, bodySource: '', steps: [], readable: readableTest(name) })
  vi.mocked(getFeatureTests).mockResolvedValueOnce([{ file: '/alpha/a.spec.ts', tests: [test('resolved alpha')] }])
    .mockResolvedValueOnce([{ file: '/beta/b.spec.ts', tests: [test('resolved beta')] }])
    .mockResolvedValue([{ file: '/alpha/a.spec.ts', tests: [test('${alpha}')], discoveryError: 'Discovery failed' }])
  const render = (feature: string) => act(async () => root.render(<TestCasesColumn feature={feature} activeRunStatus={undefined} activeRunSummary={undefined} />))
  await render('alpha'); await render('beta'); await render('alpha')
  expect(container.textContent).toContain('Showing the previous test list')
  expect(container.textContent).toContain('resolved alpha')
  expect(container.textContent).not.toContain('resolved beta')
  expect(container.textContent).not.toContain('${alpha}')
})

it('copies the server repair prompt and offers manual copy when clipboard access fails', async () => {
  const prompt = 'Repair alpha discovery. Diagnostic: missing fixture. Preserve every assertion.'
  const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard unavailable')).mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.mocked(getFeatureTests).mockResolvedValue([{
    file: '/alpha/a.spec.ts', tests: [], discoveryError: 'Discovery failed', discoveryRepairPrompt: prompt,
  }])
  await act(async () => root.render(<TestCasesColumn feature="alpha" activeRunStatus={undefined} activeRunSummary={undefined} />))
  const copy = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy repair prompt')!
  await act(async () => copy().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('copy it manually')
  expect(container.textContent).toContain('View repair prompt')
  expect(container.textContent).toContain(prompt)
  await act(async () => copy().click())
  expect(writeText).toHaveBeenLastCalledWith(prompt)
  expect(container.textContent).toContain('Copied repair prompt')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

// Names were changed from @req/@variant tags to a whatsapp: prefix after
// this recorded run. Loading workspace source made all 98 results pending.
it('keeps all recorded verdicts when current test names changed', async () => {
  const { default: recorded } = await import('@/features/runs/utils/__fixtures__/cns-wa-renamed.json')
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
    file: 'current.spec.ts', tests: [{ name: 'whatsapp: renamed current test', line: 1, bodySource: '{}', steps: [], readable: readableTest('current') }],
  }])
  await act(async () => root.render(<TestCasesColumn feature="cns-wa-merchant" activeRunStatus="failed" activeRunManifest={recorded.manifest as RunManifest} activeRunSummary={summary} />))
  expect(getFeatureTests).toHaveBeenCalledWith('cns-wa-merchant', undefined, recorded.manifest.runId)
  const labels = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
  expect(labels.filter((text) => text.endsWith('passed'))).toHaveLength(85)
  expect(labels.filter((text) => text.endsWith('failed'))).toHaveLength(4)
  expect(labels.filter((text) => text.endsWith('skipped'))).toHaveLength(9)
  expect(labels.filter((text) => text.endsWith('pending'))).toHaveLength(0)
  expect(container.textContent).not.toContain('renamed current test')
  expect(container.textContent).toContain('85/98')

  vi.mocked(getFeatureTests).mockRejectedValue(new ApiError(409, { error: 'Snapshot unavailable' }))
  await act(async () => root.render(<TestCasesColumn feature="cns-wa-merchant" activeRunStatus="failed" activeRunManifest={{ ...recorded.manifest, runId: 'missing' } as RunManifest} activeRunSummary={summary} />))
  expect(container.textContent).toContain('Recorded tests unavailable')
  expect(container.textContent).not.toContain('a new app can read')
  expect(container.textContent).not.toContain('Repair in Canary Lab')
  expect(container.textContent).toContain('Snapshot unavailable')
  expect(container.textContent).toContain('Reload recorded tests')
  expect(container.textContent).not.toContain('Retry discovery')
})

it('loads the recorded roster when it arrives after the run booted', async () => {
  const manifest = { runId: 'booting-run', featureDir: '/workspace/features/suite', suiteSnapshot: { kind: 'taken', dir: '/workspace/logs/runs/booting-run/suite', takenAt: '', digest: '' } } as RunManifest
  vi.mocked(getFeatureTests).mockResolvedValueOnce([])
  await act(async () => root.render(<TestCasesColumn feature="suite" activeRunStatus="running" activeRunManifest={manifest} activeRunSummary={undefined} />))
  expect(container.textContent).toContain('Waiting for this run to record its test list.')
  const name = 'recorded test'
  const file = `${manifest.suiteSnapshot!.kind === 'taken' ? manifest.suiteSnapshot!.dir : ''}/e2e/a.spec.ts`
  vi.mocked(getFeatureTests).mockResolvedValue([{ file, tests: [{ name, line: 1, bodySource: '{}', steps: [], readable: readableTest(name) }] }])
  const summary: RunSummary = { complete: false, total: 1, passed: 0, failed: [], passedIds: [], knownTests: [{ id: 'one', name: 'test-case-recorded-test', title: name, location: `${file}:1` }] }
  await act(async () => root.render(<TestCasesColumn feature="suite" activeRunStatus="running" activeRunManifest={manifest} activeRunSummary={summary} />))
  expect(container.textContent).not.toContain('Recorded tests unavailable')
  expect(container.textContent).toContain(name)
  expect(getFeatureTests).toHaveBeenCalledTimes(2)
})

it('shows the 23 recorded legacy auth passes without offering current source as evidence', async () => {
  const { default: legacy } = await import('@/features/runs/utils/__fixtures__/cns-legacy-auth.json')
  const summary = legacy.summary as RunSummary
  const specs = summary.knownTests!.map((known) => {
    const [, file, line] = /^(.*?):(\d+)$/.exec(known.location!)!
    return { file, recordedSourceUnavailable: true, tests: [{ name: known.title!, line: Number(line), bodySource: '', steps: [], readable: readableTest(known.title!) }] }
  })
  vi.mocked(getFeatureTests).mockResolvedValue(specs)
  await act(async () => root.render(<TestCasesColumn feature={legacy.manifest.feature} activeRunManifest={legacy.manifest as RunManifest} activeRunStatus="passed" activeRunSummary={summary} />))
  expect(container.textContent).toContain('23/23')
  expect([...container.querySelectorAll('button')].filter((button) => button.textContent?.endsWith('passed'))).toHaveLength(23)
  expect(container.textContent).toContain('Historical source is unavailable')
  expect(container.textContent).toContain('Source was not retained for this test')
  expect(container.textContent).not.toContain('Recorded tests unavailable')
  expect(container.textContent).not.toContain('Retry discovery')
  expect(container.querySelector('[aria-label="Open in editor"]')).toBeNull()
})

it('explains an aborted run with no roster without inviting discovery retries', async () => {
  vi.mocked(getFeatureTests).mockResolvedValue([])
  const manifest = { runId: 'aborted-before-start', featureDir: '/workspace/features/suite' } as RunManifest
  await act(async () => root.render(<TestCasesColumn feature="suite" activeRunManifest={manifest} activeRunStatus="aborted" activeRunSummary={undefined} />))
  expect(container.textContent).toContain('This run has no recorded test list')
  expect(container.textContent).not.toContain('Retry discovery')
  expect(container.textContent).not.toContain('No spec files found')
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
    return <TestCasesColumn feature="suite" currentTests={current} onCurrentTestsChange={setCurrent} activeRunManifest={current ? undefined : manifest} activeRunStatus={current ? undefined : 'aborted'} activeRunSummary={undefined} />
  }
  await act(async () => root.render(<View />))
  expect(container.textContent).toContain('This run has no recorded test list')
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find((button) => button.textContent === label)
    expect(button).toBeTruthy()
    button!.click()
  })
  await click('View current tests')
  expect(getFeatureTests).toHaveBeenLastCalledWith('suite', undefined, undefined)
  expect(container.textContent).toContain('current test')
  expect(container.textContent).toContain('Current source')
  expect(container.textContent).not.toContain('pending')
  expect(container.textContent).not.toContain('passed')
  await click('View recorded results')
  expect(getFeatureTests).toHaveBeenLastCalledWith('suite', undefined, 'old-run')
  expect(container.textContent).toContain('This run has no recorded test list')
  expect(container.textContent).not.toContain('expect(200)')
})
