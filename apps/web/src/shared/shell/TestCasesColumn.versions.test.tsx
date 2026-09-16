// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { FeatureSpecFile, RunSummary } from '../api/types'
import { readableTest } from '../api/__fixtures__/readable-test'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), getFeatureTests: vi.fn(), getTestFileDifference: vi.fn() }))
vi.mock('./use-discovery-repair', () => ({ useDiscoveryRepair: () => ({ repairs: [], start: vi.fn(), starting: false, error: null }) }))
vi.mock('../ui/TestPresentation', () => ({ TestPresentation: () => null }))

const manifest = { runId: 'r1', featureDir: '/source', suiteSnapshot: { kind: 'taken' as const, dir: '/recorded', takenAt: 'now', digest: 'd' } }
const spec = (root: string, names: string[], file = 'e2e/a.spec.ts'): FeatureSpecFile => ({ file: `${root}/${file}`, tests: names.map((name, i) => ({ name, line: i * 10 + 1, bodySource: '', steps: [], readable: readableTest(name) })) })
const summary: RunSummary = { complete: true, total: 3, passed: 1, passedNames: ['test-case-passed'], skippedNames: ['test-case-skipped'], failed: [{ name: 'test-case-failed', error: { message: 'Failed assertion' } }] }
let root: Root
let container: HTMLDivElement
const review = vi.fn()
let current: FeatureSpecFile[]
let recorded: FeatureSpecFile[]
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
function View({ baseline = manifest, result = summary }: { baseline?: typeof manifest; result?: RunSummary }) {
  const [source, setSource] = useState(true)
  invalidate = useInvalidation().invalidate
  return <TestCasesColumn feature="suite" currentTests={source} onCurrentTestsChange={setSource} baselineRun={baseline}
    baselineRunSummary={result} baselineRunStatus="passed" activeRunManifest={source ? undefined : baseline}
    activeRunSummary={source ? undefined : result} activeRunStatus={source ? undefined : 'passed'} onReviewTest={review} />
}
beforeEach(() => {
  vi.resetAllMocks()
  current = [spec('/source', ['passed', 'failed', 'skipped', 'new'])]
  recorded = [spec('/recorded', ['passed', 'failed', 'skipped'])]
  vi.mocked(api.getFeatureTests).mockImplementation(async (_feature, _opts, runId) => runId ? recorded : current)
  vi.mocked(api.getTestFileDifference).mockResolvedValue({ changed: true, affectedTests: ['new'] })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render(props: Parameters<typeof View>[0] = {}) { await act(async () => root.render(<InvalidationProvider><View {...props} /></InvalidationProvider>)) }
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const header = () => container.querySelector('.cl-tests-header')!

it('keeps both counts in the header without attaching recorded verdicts to current cards', async () => {
  await render()
  expect(button('Current source').closest('.cl-tests-header')).not.toBeNull()
  expect(button('Current source').textContent).toBe('Source 4')
  expect(button('Recorded run').textContent).toContain('✓1/3')
  expect(button('Recorded run').textContent).toContain('×1')
  expect(button('Recorded run').textContent).toContain('↷1')
  expect(header().textContent).toContain('1new')
  expect([...container.querySelectorAll('.cl-card')].every((card) => card.textContent?.includes('Not verified') || card.textContent?.includes('Changed since run'))).toBe(true)
  await act(async () => button('Recorded run').click())
  expect(button('Current source').textContent).toBe('Source 4')
  expect(button('Recorded run').textContent).toContain('✓1/3')
  expect(container.querySelectorAll('.cl-card')).toHaveLength(3)
  await act(async () => button('Current source').click())
  expect(container.querySelectorAll('.cl-card')).toHaveLength(4)
})

it('opens the existing dialog directly, with a new test focused by file and line', async () => {
  await render()
  await act(async () => button('Compare 1 new tests').click())
  expect(review).toHaveBeenLastCalledWith('e2e/a.spec.ts', 31, 'run')
  await act(async () => button('Compare recorded tests with current source').click())
  expect(review).toHaveBeenLastCalledWith('e2e/a.spec.ts', undefined, 'run')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('never labels failures or skips as new and still offers an unchanged comparison', async () => {
  current = [spec('/source', ['passed', 'failed', 'skipped'])]
  vi.mocked(api.getTestFileDifference).mockResolvedValue({ changed: false })
  await render()
  expect(header().textContent).not.toContain('new')
  expect(button('Recorded run').textContent).toContain('✓1/3')
  await act(async () => button('Compare recorded tests with current source').click())
  expect(review).toHaveBeenCalledWith('e2e/a.spec.ts', undefined, 'run')
})

it('compares the union of files so removed files remain accessible from source mode', async () => {
  recorded.push(spec('/recorded', ['removed'], 'e2e/deleted.spec.ts'))
  await render()
  expect(api.getTestFileDifference).toHaveBeenCalledWith('suite', 'e2e/deleted.spec.ts', 'r1')
  await act(async () => button('Compare 1 removed tests').click())
  expect(review).toHaveBeenLastCalledWith('e2e/deleted.spec.ts', 1, 'run')
})

it('clears old change counts and refreshes both versions after a test update', async () => {
  await render()
  let finish!: (specs: FeatureSpecFile[]) => void
  vi.mocked(api.getFeatureTests).mockImplementation((_feature, _opts, runId) => runId ? Promise.resolve(recorded) : new Promise((resolve) => { finish = resolve }))
  await act(async () => invalidate('tests'))
  expect(header().textContent).not.toContain('new')
  expect(button('Current source').textContent).toBe('Source —')
  vi.mocked(api.getTestFileDifference).mockResolvedValue({ changed: false })
  await act(async () => finish([spec('/source', ['passed', 'failed', 'skipped'])]))
  expect(button('Current source').textContent).toBe('Source 3')
  expect(header().textContent).not.toContain('new')
})

it.each(['missing', 'request', 'parse'] as const)('discloses unknown comparisons instead of guessing additions: %s', async (mode) => {
  if (mode === 'missing') recorded = recorded.map((file) => ({ ...file, recordedSourceUnavailable: true }))
  if (mode === 'request') vi.mocked(api.getTestFileDifference).mockRejectedValue(new Error('Snapshot unavailable'))
  if (mode === 'parse') current = current.map((file) => ({ ...file, parseError: 'Invalid syntax' }))
  await render()
  expect(header().textContent).not.toContain('new')
  const compare = container.querySelector<HTMLButtonElement>('[data-testid="test-version-compare"]')!
  expect(compare.getAttribute('aria-disabled')).toBe('true')
  expect(compare.getAttribute('aria-label')).toContain('unknown')
  await act(async () => compare.click())
  expect(review).not.toHaveBeenCalled()
})

it('ignores a late response from a previously selected run', async () => {
  let finish!: (specs: FeatureSpecFile[]) => void
  vi.mocked(api.getFeatureTests).mockImplementation((_feature, _opts, runId) => runId === 'r1' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(runId ? [spec('/recorded', ['passed', 'failed', 'skipped', 'new'])] : current))
  await render()
  await render({ baseline: { ...manifest, runId: 'r2' } })
  expect(header().textContent).not.toContain('new')
  await act(async () => finish(recorded))
  expect(header().textContent).not.toContain('new')
  expect(api.getTestFileDifference).toHaveBeenLastCalledWith('suite', 'e2e/a.spec.ts', 'r2')
})
