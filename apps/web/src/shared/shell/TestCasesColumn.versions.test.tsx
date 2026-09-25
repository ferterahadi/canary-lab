// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { FeatureSpecFile, RunSummary } from '../api/types'
import type { TestSourceComparison } from '@shared/test-review'
import { readableTest } from '../api/__fixtures__/readable-test'
import { TestCasesColumn } from './TestCasesColumn'
import { InvalidationProvider, useInvalidation } from '../state/invalidation'

vi.mock('../api/client', async (original) => ({ ...await original<typeof api>(), getFeatureTests: vi.fn(), getFeatureTestsPreview: vi.fn(), getTestSourceComparison: vi.fn() }))
vi.mock('./use-discovery-repair', () => ({ useDiscoveryRepair: () => ({ repairs: [], start: vi.fn(), starting: false, startError: null }) }))
vi.mock('../ui/TestPresentation', () => ({ TestPresentation: () => null }))

const manifest = { runId: 'r1', featureDir: '/source', suiteSnapshot: { kind: 'taken' as const, dir: '/recorded', takenAt: 'now', digest: 'd' } }
const spec = (root: string, names: string[], file = 'e2e/a.spec.ts'): FeatureSpecFile => ({ file: `${root}/${file}`, tests: names.map((name, i) => ({ name, line: i * 10 + 1, bodySource: '', steps: [], readable: readableTest(name) })) })
const summary: RunSummary = { complete: true, total: 3, passed: 1, passedNames: ['test-case-passed'], skippedNames: ['test-case-skipped'], failed: [{ name: 'test-case-failed', error: { message: 'Failed assertion' } }] }
const noChanges: TestSourceComparison = { state: 'ready', files: ['e2e/a.spec.ts'], differences: [], changes: { added: [], changed: [], removed: [] } }
let root: Root
let container: HTMLDivElement
const review = vi.fn()
let current: FeatureSpecFile[]
let recorded: FeatureSpecFile[]
let comparison: TestSourceComparison
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
function View({ baseline = manifest, result = summary }: { baseline?: typeof manifest; result?: RunSummary }) {
  const [source, setSource] = useState(true)
  invalidate = useInvalidation().invalidate
  const evidence = { manifest: baseline, summary: result, status: 'passed' as const }
  return <TestCasesColumn feature="suite" currentTests={source} onCurrentTestsChange={setSource}
    runEvidence={evidence} comparisonBaseline={evidence} onReviewTest={review} />
}
beforeEach(() => {
  vi.resetAllMocks()
  current = [spec('/source', ['passed', 'failed', 'skipped', 'new'])]
  recorded = [spec('/recorded', ['passed', 'failed', 'skipped'])]
  comparison = { ...noChanges, differences: [{ file: 'e2e/a.spec.ts', affectedTests: ['new'] }], changes: { added: [{ file: 'e2e/a.spec.ts', name: 'new', line: 31, endLine: 39 }], changed: [], removed: [] } }
  vi.mocked(api.getFeatureTests).mockImplementation(async (_feature, _opts, runId) => runId ? recorded : current)
  vi.mocked(api.getFeatureTestsPreview).mockResolvedValue([])
  vi.mocked(api.getTestSourceComparison).mockImplementation(async () => comparison)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render(props: Parameters<typeof View>[0] = {}) { await act(async () => root.render(<InvalidationProvider><View {...props} /></InvalidationProvider>)) }
// The tabs carry their full sentence as the accessible name — the visible tab is
// a glyph and a ratio, so the failed and skipped counts live only here. Match on
// the prefix so a test can name a tab without restating that whole sentence.
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)!

it('keeps runtime totals and verdicts separate from source declaration changes', async () => {
  await render()
  expect(button('Current source').textContent).toBe('4')
  expect(button('Recorded run').textContent).toBe('1/3')
  expect(button('Recorded run').getAttribute('aria-label')).toContain('1 failed')
  expect(button('Recorded run').getAttribute('aria-label')).toContain('1 skipped')
  expect(button('Compare 1 new tests')).not.toBeNull()
  expect(container.querySelectorAll('.cl-card > button > span.uppercase')).toHaveLength(0)
  expect(container.querySelectorAll('[data-testid="test-modified-dot"]')).toHaveLength(1)
  await act(async () => button('Recorded run').click())
  expect(button('Current source').textContent).toBe('4')
  expect(button('Recorded run').textContent).toBe('1/3')
  expect(container.querySelectorAll('.cl-card')).toHaveLength(3)
  await act(async () => button('Current source').click())
  expect(container.querySelectorAll('.cl-card')).toHaveLength(4)
})
it('opens the declaration from its count with file, line, category and identity', async () => {
  await render()
  await act(async () => button('Compare 1 new tests').click())
  expect(review).toHaveBeenLastCalledWith('e2e/a.spec.ts', 31, 'run', 'added', 'new')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
it('uses declaration changes even when the runtime test roster is unchanged', async () => {
  comparison = { ...noChanges, changes: { added: [], removed: [], changed: [{ file: 'e2e/a.spec.ts', name: 'failed', line: 11, endLine: 18 }] } }
  await render()
  await act(async () => button('Compare 1 changed tests').click())
  expect(review).toHaveBeenLastCalledWith('e2e/a.spec.ts', 11, 'run', 'changed', 'failed')
})
it('never turns extra runtime cases or stale recorded names into new declarations', async () => {
  current.push(spec('/source', ['generated a', 'generated b']))
  recorded.push(spec('/recorded', ['old title']))
  comparison = noChanges
  await render()
  expect(button('Compare 1 new tests')).toBeNull()
  expect(button('Compare 1 removed tests')).toBeNull()
  // A clean comparison and an unknown one are different facts, so a clean one
  // draws nothing at all rather than borrowing the mark that discloses "we could
  // not work out what changed".
  expect(container.querySelector('.cl-test-changes')?.children).toHaveLength(0)
  expect(container.querySelector('[data-testid="test-version-compare"]')).toBeNull()
})
it('keeps removed declarations accessible even without a corresponding runtime record', async () => {
  comparison = { ...noChanges, files: ['e2e/a.spec.ts', 'e2e/deleted.spec.ts'], changes: { added: [], changed: [], removed: [{ file: 'e2e/deleted.spec.ts', name: 'removed', line: 1, endLine: 4 }] } }
  await render()
  expect(api.getTestSourceComparison).toHaveBeenCalledWith('suite', 'r1')
  await act(async () => button('Compare 1 removed tests').click())
  expect(review).toHaveBeenLastCalledWith('e2e/deleted.spec.ts', 1, 'run', 'removed', 'removed')
})
it('clears old counts while refreshing the source comparison after edits', async () => {
  await render()
  let finish!: (value: TestSourceComparison) => void
  vi.mocked(api.getTestSourceComparison).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  await act(async () => invalidate('tests'))
  expect(button('Compare 1 new tests')).toBeNull()
  await act(async () => finish(noChanges))
  expect(button('Compare 1 new tests')).toBeNull()
})
it.each(['request', 'parse'] as const)('discloses unknown comparisons instead of guessing additions: %s', async (mode) => {
  if (mode === 'request') vi.mocked(api.getTestSourceComparison).mockRejectedValue(new Error('Snapshot unavailable'))
  else comparison = { state: 'unavailable', files: [], differences: [], reasons: ['Invalid source'] }
  await render()
  expect(button('Compare 1 new tests')).toBeNull()
  // An unknown comparison has no drift to open, so it discloses itself as a MARK
  // and not a control — a button here would promise a review the header cannot
  // produce, which is how the removed "Compare recorded tests…" button read.
  const compare = container.querySelector<HTMLElement>('[data-testid="test-version-compare"]')!
  expect(compare.tagName).toBe('SPAN')
  expect(compare.getAttribute('aria-label')).toContain('unknown')
  await act(async () => compare.click())
  expect(review).not.toHaveBeenCalled()
})
it('ignores a late source comparison from a previously selected run', async () => {
  let finish!: (value: TestSourceComparison) => void
  vi.mocked(api.getTestSourceComparison).mockImplementation((_feature, runId) => runId === 'r1' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(noChanges))
  await render()
  await render({ baseline: { ...manifest, runId: 'r2' } })
  expect(button('Compare 1 new tests')).toBeNull()
  await act(async () => finish(comparison))
  expect(button('Compare 1 new tests')).toBeNull()
  expect(api.getTestSourceComparison).toHaveBeenLastCalledWith('suite', 'r2')
})
