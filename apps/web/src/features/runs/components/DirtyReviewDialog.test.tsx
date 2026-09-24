// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Feature, RunIndexEntry, RunDetail } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { multilineImportReview, testFileReview } from '@/shared/api/__fixtures__/test-review'
import { DirtyReviewDialog } from './DirtyReviewDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/shared/api/client', async (original) => ({ ...await original<typeof api>(),
  getTestFileReview: vi.fn(), getTestSourceComparison: vi.fn(), getFeatureTests: vi.fn(), getRunTestReview: vi.fn(), getFeatureTestReview: vi.fn(), acceptFeatureTestReview: vi.fn(), restoreFeatureTestReview: vi.fn(), acceptRunTestReview: vi.fn(), restoreSpecEdits: vi.fn(), openEditor: vi.fn(), openWorkspace: vi.fn(),
}))
vi.mock('../state/RunsContext', () => ({ useRun: () => ({ detail: undefined, error: null }) }))
let root: Root
let container: HTMLDivElement
const feature = (name = 'alpha', files = ['e2e/a.spec.ts']): Feature => ({ name, description: '', envs: [], repos: [], dirty: { status: 'dirty', specs: files.map((file) => ({ file, affectedTests: ['a'] })) } })
const run = { runId: 'run-1', feature: 'alpha', status: 'healing', pendingSpecEdits: 1 } as RunIndexEntry
const detail = { manifest: { runId: 'run-1', feature: 'alpha', specEdits: { pending: [{ file: 'e2e/a.spec.ts', affectedTests: ['a'] }] } } } as RunDetail
const reviewRevision = 'a'.repeat(64)
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getFeatureTests).mockResolvedValue([])
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: [], differences: [], changes: { added: [], changed: [], removed: [] } })
  vi.mocked(api.getTestFileReview).mockResolvedValue(testFileReview())
  vi.mocked(api.getRunTestReview).mockResolvedValue({ runId: 'run-1', feature: 'alpha', baseline: 'run-start', review_revision: reviewRevision,
    files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], canAdopt: true })
  vi.mocked(api.getFeatureTestReview).mockImplementation(async (name) => ({ feature: name, baseline: 'head', review_revision: reviewRevision,
    files: name === 'alpha' ? [{ file: 'e2e/a.spec.ts', change: 'modified' }] : [] }))
  vi.mocked(api.acceptFeatureTestReview).mockResolvedValue({ decision: 'accepted', review_revision: reviewRevision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed', commit: 'abc' }, execution: { status: 'none' } })
  vi.mocked(api.restoreFeatureTestReview).mockResolvedValue({ decision: 'restored', review_revision: reviewRevision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'not-requested' }, execution: { status: 'none' } })
  vi.mocked(api.acceptRunTestReview).mockResolvedValue({ decision: 'accepted', review_revision: reviewRevision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed', commit: 'abc' }, execution: { status: 'rerun-requested', runId: 'run-1' } })
  vi.mocked(api.restoreSpecEdits).mockResolvedValue({ decision: 'restored', review_revision: reviewRevision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'not-requested' }, execution: { status: 'none' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (label: string) => buttons().find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!
async function render(props: Partial<Parameters<typeof DirtyReviewDialog>[0]> = {}) {
  await act(async () => root.render(<DirtyReviewDialog features={[feature()]} onClose={vi.fn()} {...props} />))
}
const click = async (label: string) => act(async () => button(label).click())
it('shows a readable fixture in English and Code with visible edits, not an empty test comparison', async () => {
  const fixture = 'e2e/fixture.ts'
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: [fixture], differences: [{ file: fixture, affectedTests: [] }], changes: { added: [], changed: [], removed: [] } })
  vi.mocked(api.getTestFileReview).mockResolvedValue({ file: fixture, currentPath: `/suite/${fixture}`, baseline: 'run-start', supportingFile: true,
    before: { source: 'export const ready = false\n', tests: [], story: { steps: [{ id: 'before', role: 'setup', text: 'Export ready as false', spans: [{ text: 'Export ready as false' }], fidelity: 'derived', source: { file: fixture, startLine: 1, endLine: 1, snippet: 'export const ready = false' } }] } },
    after: { source: 'export const ready = true\n', tests: [], story: { steps: [{ id: 'after', role: 'setup', text: 'Export ready as true', spans: [{ text: 'Export ready as true' }], fidelity: 'derived', source: { file: fixture, startLine: 1, endLine: 1, snippet: 'export const ready = true' } }] } },
    patch: '@@ -1 +1 @@\n-export const ready = false\n+export const ready = true\n', assessment: { verdict: 'unclassifiable', tests: [] } })
  await render({ focusFeature: 'alpha', focusRunId: 'run-1', focusRunDetail: detail, focus: { file: fixture, baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', fixture, 'run-1')
  expect(button('English')).not.toBeUndefined()
  expect(button('Code')).not.toBeUndefined()
  expect(document.body.textContent).not.toContain('Supporting file · Code')
  expect(document.body.textContent).toContain('Export ready as false')
  expect(document.body.textContent).toContain('Export ready as true')
  await click('Code')
  expect(document.body.textContent).toContain('export const ready = false')
  expect(document.body.textContent).toContain('export const ready = true')
  expect(document.body.textContent).not.toContain('No title or test-content changes in this file')
  expect(document.querySelector('.cl-review-file[data-changed="true"]')?.getAttribute('title')).toBe(fixture)
})
it('returns from a deep-linked import continuation to its English range and highlights that range in Code', async () => {
  const review = multilineImportReview()
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  const onFocus = vi.fn()
  await render({ focus: { file: review.file, line: 10, mode: 'code' }, onFocus })
  expect(document.querySelectorAll('tbody tr')).toHaveLength(19)
  await click('English')
  expect(onFocus).toHaveBeenLastCalledWith({ file: review.file, line: 2, mode: 'english' })
  expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="2"] button')!.click())
  expect(document.querySelectorAll('[data-source-selected]')).toHaveLength(17)
  await act(async () => document.querySelector<HTMLButtonElement>('button[data-side="after"][data-source-line="18"]')!.click())
  expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  expect(document.activeElement?.closest('[data-source-line]')?.getAttribute('data-source-line')).toBe('2')
})
it('anchors the format toggle to the visible code line after scrolling into a multiline import', async () => {
  const review = multilineImportReview()
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  const onFocus = vi.fn()
  await render({ focus: { file: review.file, line: 1, mode: 'code' }, onFocus })
  const visible = document.querySelector<HTMLElement>('[data-side="after"][data-source-line="12"]')!
  const rect = vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 40, height: 20 } as DOMRect)
  try {
    await click('English')
    expect(onFocus).toHaveBeenLastCalledWith({ file: review.file, line: 2, mode: 'english' })
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  } finally { rect.mockRestore() }
})
it('opens a clean suite against its selected historical run and lists files from both versions', async () => {
  const clean = { ...feature(), dirty: undefined }
  const historical = { manifest: { ...detail.manifest, runId: 'old-run', featureDir: '/source', suiteSnapshot: { kind: 'taken', dir: '/recorded', takenAt: 'now', digest: 'd' } } } as RunDetail
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: ['e2e/a.spec.ts', 'e2e/deleted.spec.ts', 'e2e/new.spec.ts'], differences: [], changes: { added: [], changed: [], removed: [] } })
  const onFocus = vi.fn()
  await render({ features: [clean], focusFeature: 'alpha', focusRunId: 'old-run', focusRunDetail: historical,
    focus: { file: 'e2e/new.spec.ts', line: 20, baseline: 'run' }, onFocus })
  expect(api.getTestFileReview).toHaveBeenCalledWith('alpha', 'e2e/new.spec.ts', 'old-run')
  expect([...document.querySelectorAll('.cl-review-file')].map((item) => item.textContent)).toEqual(expect.arrayContaining(['new.spec.ts', expect.stringContaining('deleted.spec.ts')]))
  expect([...document.querySelectorAll('.cl-review-file')].some((item) => item.textContent?.includes('0 tests'))).toBe(false)
  const deleted = [...document.querySelectorAll<HTMLButtonElement>('.cl-review-file')].find((item) => item.textContent?.startsWith('deleted.spec.ts'))!
  await act(async () => deleted.click())
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/deleted.spec.ts', mode: undefined, baseline: 'run' })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/deleted.spec.ts', 'old-run')
})

it('marks only files that differ from the selected recorded tests', async () => {
  const historical = { manifest: { ...detail.manifest, runId: 'old-run', featureDir: '/source', suiteSnapshot: { kind: 'taken', dir: '/recorded', takenAt: 'now', digest: 'd' } } } as RunDetail
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: ['e2e/a.spec.ts', 'e2e/changed.spec.ts'], differences: [{ file: 'e2e/changed.spec.ts', affectedTests: [] }], changes: { added: [], changed: [], removed: [] } })
  await render({ focusFeature: 'alpha', focusRunId: 'old-run', focusRunDetail: historical,
    focus: { file: 'e2e/changed.spec.ts', baseline: 'run' } })
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.cl-review-file')]
  expect(rows.find((row) => row.textContent === 'changed.spec.ts')).toMatchObject({ dataset: { changed: 'true' } })
  expect(rows.find((row) => row.textContent === 'changed.spec.ts')?.getAttribute('aria-label')).toContain('changed compared with the recorded tests')
  expect(rows.find((row) => row.textContent === 'a.spec.ts')?.dataset.changed).toBeUndefined()
  expect(api.getTestSourceComparison).toHaveBeenCalledTimes(1)
})

it('marks only known dirty files when comparing with Git HEAD', async () => {
  await render({ focusFeature: 'alpha', focus: { file: 'e2e/linked-clean.spec.ts' } })
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.cl-review-file')]
  expect(rows.find((row) => row.title === 'e2e/a.spec.ts')?.dataset.changed).toBe('true')
  expect(rows.find((row) => row.title === 'e2e/linked-clean.spec.ts')?.dataset.changed).toBeUndefined()
  expect(rows.find((row) => row.title === 'e2e/a.spec.ts')?.getAttribute('aria-label')).toContain('changed compared with Git HEAD')
})

it('does not replace an explicitly selected historical baseline with another pending run', async () => {
  await render({ focusFeature: 'alpha', focusRunId: 'old-run', focus: { file: 'e2e/a.spec.ts', baseline: 'run' },
    focusRunDetail: { ...detail, manifest: { ...detail.manifest, runId: 'old-run' } }, pendingRuns: [run] })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'old-run')
  expect(button('Accept & commit')).toBeUndefined()
  expect(button('Restore recorded files')).toBeUndefined()
})

it('scopes the rail to the entry suite and keeps its file positions when the baseline changes', async () => {
  const features = [feature('beta', ['e2e/z.spec.ts', 'e2e/a.spec.ts']), feature('alpha')]
  const betaRun = { ...run, feature: 'beta', status: 'passed' as const, pendingSpecEdits: 0 }
  const betaDetail = { manifest: { runId: 'run-1', feature: 'beta', specEdits: { pending: [] } } } as unknown as RunDetail
  const props = { features, pendingRuns: [betaRun], focusFeature: 'beta', focusRunId: 'run-1', focusRunDetail: betaDetail }
  const positions = () => [...document.querySelectorAll('nav .cl-review-file')].map((item) => item.getAttribute('title'))
  const suites = () => [...document.querySelectorAll('[data-testid^="dirty-review-suite-"]')].map((item) => item.getAttribute('data-testid'))
  const selectedFile = () => document.querySelector('.cl-review-file[aria-pressed="true"]')?.getAttribute('title')
  await render({ ...props, focus: { file: 'e2e/z.spec.ts', baseline: 'run' } })
  expect(suites()).toEqual(['dirty-review-suite-beta'])
  expect(positions()).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts'])
  expect(selectedFile()).toBe('e2e/z.spec.ts')
  expect(document.querySelector('[data-testid="dirty-review-suite-beta"]')?.textContent).toContain('Changed')
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('select[aria-label="Compare current test with"]')!; select.value = 'head'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('beta', 'e2e/z.spec.ts', undefined)
  expect(positions()).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts'])
  expect(selectedFile()).toBe('e2e/z.spec.ts')
  await render({ ...props, pendingRuns: [], focusFeature: 'alpha', focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(suites()).toEqual(['dirty-review-suite-alpha'])
  expect(positions()).toEqual(['e2e/a.spec.ts'])
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Compare current test with"]')?.value).toBe('head')
  expect(document.querySelector<HTMLOptionElement>('option[value="run"]')?.disabled).toBe(true)
})

it('follows baseline navigation from the URL without moving the selected file', async () => {
  vi.mocked(api.getRunTestReview).mockResolvedValue({ runId: 'run-1', feature: 'alpha', baseline: 'run-start', review_revision: reviewRevision,
    files: [], canAdopt: false, reviewState: 'settled', allowedActions: [], nextAction: 'none' })
  const props = { pendingRuns: [run], focusRunDetail: detail, focusRunId: 'run-1', focusFeature: 'alpha' }
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  await render({ ...props, focus: { file: 'e2e/a.spec.ts' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
})

it('shows a whole test with equal before/after columns, unchanged context and exact source edits', async () => {
  await render()
  await click('Code')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Committed tests · Git HEAD', 'Current source'])
  expect(document.querySelector('tbody')?.textContent).toContain('const context = x')
  expect(document.querySelector('del')?.textContent).toBe('  expect(x).toBe(1)')
  expect(document.querySelector('ins')?.textContent).toBe('  expect(x).toBe(2)')
  expect(document.body.textContent).toContain('Edit 1 / 2')
  expect(document.body.textContent).toContain('Different expected values are not ordered by strength')
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
  expect(document.querySelector('[aria-label="Test context"]')).toBeNull()
  expect(document.querySelector('.cl-comparison-legend')).toBeNull()
  expect(document.querySelector('[aria-label="Open workspace in editor"]')).toBeNull()
  expect(button('Code').className).toBe('cl-lang-switch-btn')
})
it('keeps the selected change when switching English and Code and exposes full-file setup', async () => {
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next change"]')!.click())
  await click('Code')
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
  await click('English')
  expect(document.body.textContent).toContain('Edit 2 / 2')
})
it.each(['before', 'after'] as const)('opens the exact %s source range when an English sentence is clicked', async (side) => {
  const review = testFileReview()
  // The selected sentence is outside the active change and covers two lines.
  // The click must follow its own source range, not jump to the diff cursor.
  review[side].story = { steps: [{ id: 'setup', role: 'setup', text: 'Set up x and check it', spans: [{ text: 'Set up x and check it' }], fidelity: 'derived',
    source: { file: review.file, startLine: 6, endLine: 7, snippet: review[side].source.split('\n').slice(5, 7).join('\n') } }] }
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  const onFocus = vi.fn()
  const scrolled: Element[] = []
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
  try {
    await render({ onFocus })
    const target = document.querySelector<HTMLButtonElement>(`[data-side="${side}"][data-source-line="6"] button`)!
    expect(target.title).toContain('code at line 6')
    const pane = document.querySelector<HTMLElement>('.cl-comparison-wrap')!
    pane.scrollTop = 317; pane.scrollLeft = 24
    await act(async () => target.click())
    expect(button('Code').getAttribute('aria-selected')).toBe('true')
    expect(onFocus).toHaveBeenLastCalledWith({ file: review.file, line: 6, mode: 'code' })
    await render({ onFocus, focus: { file: review.file, line: 6, mode: 'code' } })
    expect(document.body.textContent).toContain('Edit 1 / 2')
    expect([...document.querySelectorAll('[data-source-selected]')].map((element) => [element.getAttribute('data-side'), element.getAttribute('data-source-line')])).toEqual([[side, '6'], [side, '7']])
    expect(document.activeElement?.getAttribute('data-source-line')).toBe('6')
    expect(scrolled.at(-1)).toBe(document.activeElement)
    expect(document.activeElement?.textContent).toContain('const context = x')
    pane.scrollTop = 900; pane.scrollLeft = 80
    await act(async () => document.querySelector<HTMLButtonElement>(`button[data-side="${side}"][data-source-line="7"]`)!.click())
    expect(button('English').getAttribute('aria-selected')).toBe('true')
    expect(scrolled.at(-1)?.getAttribute('data-source-line')).toBe('6')
    expect(pane.scrollTop).toBe(317)
    expect(pane.scrollLeft).toBe(24)
    expect(document.activeElement).toBe(document.querySelector(`[data-side="${side}"][data-source-line="6"] button`))
    await click('Next change')
    expect(document.querySelector('[data-source-selected]')).toBeNull()
  } finally { scrollIntoView.mockRestore() }
})
it('returns from the original code line to the saved English place after browsing other changes', async () => {
  await render()
  expect(button('← Back to English')).toBeUndefined()
  // Even source retained literally in English mode has a return location.
  const sentence = document.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="1"] button')!
  const pane = document.querySelector<HTMLElement>('.cl-comparison-wrap')!
  pane.scrollTop = 413; pane.scrollLeft = 17
  await act(async () => sentence.click())
  expect(button('← Back to English')).toBeUndefined()
  expect(document.querySelector('button[data-side="after"][data-source-line="1"]')).not.toBeNull()
  await click('Next change')
  expect(document.body.textContent).toContain('Edit 2 / 2')
  pane.scrollTop = 1900; pane.scrollLeft = 60
  await act(async () => document.querySelector<HTMLButtonElement>('button[data-side="after"][data-source-line="1"]')!.click())
  expect(button('English').getAttribute('aria-selected')).toBe('true')
  expect(pane.scrollTop).toBe(413)
  expect(pane.scrollLeft).toBe(17)
  expect(document.body.textContent).toContain('Edit 1 / 2')
  expect(document.activeElement).toBe(document.querySelector('[data-side="after"][data-source-line="1"] button'))
  expect(button('← Back to English')).toBeUndefined()
  // A later toggle saves the reader's new English scroll position.
  pane.scrollTop = 522; pane.scrollLeft = 30
  await click('Code')
  await click('English')
  expect(pane.scrollTop).toBe(522)
  expect(pane.scrollLeft).toBe(30)
  await click('Next change')
  await click('Code')
  expect(document.querySelector('button[data-source-line]')).toBeNull()
})
it('opens the requested suite and source line and keeps file focus on live refresh', async () => {
  const onFocus = vi.fn()
  await render({ features: [feature('beta'), feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts'])], focusFeature: 'alpha', focus: { file: 'e2e/b.spec.ts', line: 3 }, onFocus })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/b.spec.ts', undefined)
  await click('Code')
  expect(onFocus).toHaveBeenCalledWith({ file: 'e2e/b.spec.ts', line: 3, mode: 'code' })
})
it('re-fetches changed source rather than retaining cached line highlights', async () => {
  await render()
  const next = feature(); next.dirty!.specs[0].affectedTests.push('new')
  await render({ features: [next] })
  expect(api.getTestFileReview).toHaveBeenCalledTimes(2)
})
it('refreshes an open run review when its pushed manifest records a decision', async () => {
  const props = { pendingRuns: [run], focusRunId: 'run-1', focusFeature: 'alpha' }
  await render({ ...props, focusRunDetail: detail })
  expect(api.getRunTestReview).toHaveBeenCalledTimes(1)
  const decided = { manifest: { ...detail.manifest, specEdits: {
    ...detail.manifest.specEdits,
    reviewDecisions: [{ at: '2026-09-19T00:00:00.000Z', revision: reviewRevision, decision: 'adopted' as const }],
  } } } as RunDetail
  await render({ ...props, focusRunDetail: decided })
  expect(api.getRunTestReview).toHaveBeenCalledTimes(2)
})
it('shows only the two review decisions for a suite and accepts the exact revision', async () => {
  const onClose = vi.fn()
  const onFeaturesChanged = vi.fn()
  await render({ features: [feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts'])], onClose, onFeaturesChanged })
  expect([...document.querySelectorAll('.cl-review-commit-buttons button')].map((item) => item.textContent)).toEqual(['Restore recorded files', 'Accept & commit'])
  expect(document.body.textContent).not.toContain('Commits 2 reviewed files')
  expect(document.body.textContent).not.toContain('Accepts these files')
  await click('Accept & commit')
  expect(api.acceptFeatureTestReview).toHaveBeenCalledExactlyOnceWith('alpha', reviewRevision)
  expect(onFeaturesChanged).toHaveBeenCalledExactlyOnceWith()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('restores the exact suite review revision', async () => {
  const onClose = vi.fn()
  const onAccepted = vi.fn()
  await render({ onClose, onAccepted })
  await click('Restore recorded files')
  expect(api.restoreFeatureTestReview).toHaveBeenCalledExactlyOnceWith('alpha', reviewRevision)
  expect(api.acceptFeatureTestReview).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
  expect(onAccepted).not.toHaveBeenCalled()
})
it('surfaces a failed suite acceptance and allows retry', async () => {
  const onAccepted = vi.fn()
  vi.mocked(api.acceptFeatureTestReview).mockRejectedValue(new Error('Git rejected the commit'))
  await render({ onAccepted }); await click('Accept & commit')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Git rejected the commit')
  expect(button('Accept & commit').disabled).toBe(false)
  expect(onAccepted).not.toHaveBeenCalled()
})
it('uses the same two decisions for an active run and accepts through one server workflow', async () => {
  const onClose = vi.fn()
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  expect([...document.querySelectorAll('.cl-review-commit-buttons button')].map((item) => item.textContent)).toEqual(['Restore recorded files', 'Accept & commit'])
  await click('Accept & commit')
  expect(api.acceptRunTestReview).toHaveBeenCalledExactlyOnceWith('run-1', reviewRevision)
  expect(api.restoreSpecEdits).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('restores the selected run tests on no without committing or accepting changes', async () => {
  const onClose = vi.fn()
  const onFeaturesChanged = vi.fn()
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose, onFeaturesChanged })
  await click('Restore recorded files')
  expect(api.restoreSpecEdits).toHaveBeenCalledWith('run-1', { expectedRevision: reviewRevision })
  expect(api.acceptRunTestReview).not.toHaveBeenCalled()
  expect(onFeaturesChanged).toHaveBeenCalledExactlyOnceWith()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('keeps the decision open when restoring fails', async () => {
  const onClose = vi.fn()
  vi.mocked(api.restoreSpecEdits).mockRejectedValue(new Error('tests-running'))
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Restore recorded files')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('tests-running')
  expect(onClose).not.toHaveBeenCalled()
  expect(button('Restore recorded files').disabled).toBe(false)
})
it('keeps the decision open when acceptance fails', async () => {
  const onClose = vi.fn()
  vi.mocked(api.acceptRunTestReview).mockRejectedValue(new Error('Git rejected the commit'))
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Accept & commit')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Git rejected the commit')
  expect(onClose).not.toHaveBeenCalled()
  expect(button('Accept & commit').disabled).toBe(false)
})
it.each([
  { ...run, status: 'queued' as const },
  { ...run, status: 'passed' as const },
])('does not offer run actions for a non-active run: %o', async (pending) => {
  await render({ pendingRuns: [pending] })
  expect(button('Accept & commit')).toBeUndefined()
  expect(button('Restore recorded files')).toBeUndefined()
  expect(api.acceptRunTestReview).not.toHaveBeenCalled()
})
it('uses the same exact-revision acceptance label for a terminal run', async () => {
  const onAccepted = vi.fn()
  const receipt = { decision: 'accepted' as const, review_revision: reviewRevision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed' as const }, execution: { status: 'new-run-required' as const, runId: 'run-1' } }
  vi.mocked(api.acceptRunTestReview).mockResolvedValue(receipt)
  const terminal = { ...run, status: 'passed' as const }
  vi.mocked(api.getRunTestReview).mockResolvedValue({
    runId: terminal.runId, feature: 'alpha', baseline: 'run-start', review_revision: reviewRevision,
    files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], canAdopt: false,
    reviewState: 'pending-terminal', allowedActions: ['approve-new-run', 'restore', 'leave-pending'], nextAction: 'restore-or-leave',
  })
  const onClose = vi.fn()
  await render({ pendingRuns: [terminal], focusRunDetail: detail, onClose, onAccepted })
  expect(onAccepted).not.toHaveBeenCalled()
  expect([...document.querySelectorAll('.cl-review-commit-buttons button')].map((item) => item.textContent)).toEqual(['Restore recorded files', 'Accept & commit'])
  await click('Accept & commit')
  expect(api.acceptRunTestReview).toHaveBeenCalledExactlyOnceWith('run-1', reviewRevision)
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
  expect(onAccepted).toHaveBeenCalledExactlyOnceWith('alpha', receipt, detail)
})
it('offers acceptance for an active supporting-only review even when no test declarations changed', async () => {
  const fixture = 'e2e/fixture.ts'
  vi.mocked(api.getRunTestReview).mockResolvedValue({ runId: 'run-1', feature: 'alpha', baseline: 'run-start', review_revision: reviewRevision,
    files: [{ file: fixture, change: 'modified' }], canAdopt: true })
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: [fixture], differences: [{ file: fixture, affectedTests: [] }], changes: { added: [], changed: [], removed: [] } })
  const supportingOnly = { ...run, pendingSpecEdits: 0 }
  const onClose = vi.fn()
  await render({ features: [{ ...feature(), dirty: undefined }], pendingRuns: [supportingOnly], focusFeature: 'alpha', focusRunId: 'run-1',
    focusRunDetail: { manifest: { ...detail.manifest, specEdits: { pending: [] } } } as RunDetail, focus: { file: fixture, baseline: 'run' }, onClose })
  expect(button('Accept & commit')).not.toBeUndefined()
  expect(button('Restore recorded files')).not.toBeUndefined()
  expect(document.body.textContent).toContain('1 changed file')
  expect(document.body.textContent).toContain('no test declaration changes')
  await click('Accept & commit')
  expect(api.acceptRunTestReview).toHaveBeenCalledExactlyOnceWith('run-1', reviewRevision)
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('locks a pending decision to the recorded-run scope it will settle', async () => {
  vi.mocked(api.getTestFileReview).mockResolvedValue({ ...testFileReview(), baseline: 'run-start' })
  await render({ pendingRuns: [run], focusRunDetail: detail, focusRunId: 'run-1' })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Recorded tests', 'Current source'])
  expect(document.querySelector<HTMLOptionElement>('option[value="head"]')?.disabled).toBe(true)
})
it('supports a committed file that differs from a completed run without showing live-run levers', async () => {
  // No pending edits: the URL is the only source of the compared filename.
  // Feed selection back through props, as URL navigation does in the app.
  const onFocus = vi.fn()
  const props = { features: [], pendingRuns: [{ ...run, status: 'passed' as const, pendingSpecEdits: 0 }], focusRunId: 'run-1',
    focusRunDetail: { ...detail, manifest: { ...detail.manifest, specEdits: { checkedAt: 'now', adopted: [], pending: [] } } }, onFocus }
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  expect(button('Pending test edits')).toBeUndefined()
  expect(document.body.textContent).not.toContain('0 edits not executed')
  expect(document.querySelector('.cl-review-file')?.textContent).toBe('a.spec.ts')
  await click('a.spec.ts')
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/a.spec.ts', baseline: 'run', mode: undefined })
  await render({ ...props, focus: onFocus.mock.calls.at(-1)![0] })
  expect(document.querySelector('table')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Loading test files')
  expect(button('Accept & commit')).toBeUndefined()
  expect(button('Restore recorded files')).toBeUndefined()
})
it('shows a recoverable empty state when a completed run has no selected file', async () => {
  await render({ features: [], pendingRuns: [{ ...run, status: 'passed', pendingSpecEdits: 0 }], focusRunId: 'run-1', focus: { baseline: 'run' } })
  expect(button('Pending test edits')).toBeUndefined()
  expect(document.body.textContent).not.toContain('Loading test files')
  expect(document.querySelector('.cl-review-content [role="status"]')?.textContent).toContain('open a comparison from the Tests panel')
  expect(api.getTestFileReview).not.toHaveBeenCalled()
})
it('discloses missing source and retries instead of presenting it as removed code', async () => {
  vi.mocked(api.getTestFileReview).mockRejectedValueOnce(new Error('Snapshot unavailable'))
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Snapshot unavailable')
  expect(document.querySelector('del')).toBeNull()
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No edits')
  expect(button('Next change').disabled).toBe(true)
  await click('Retry')
  expect(document.querySelector('table')).not.toBeNull()
})
it('does not claim the baseline matches while source is still loading', async () => {
  vi.mocked(api.getTestFileReview).mockReturnValue(new Promise(() => {}))
  await render()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading complete test source')
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No edits')
})
it('opens the existing editor at the test source without creating a new screen', async () => {
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'cursor' })
  await render({ focus: { file: 'e2e/a.spec.ts', line: 5 } }); await click('Edit e2e/a.spec.ts in editor')
  expect(api.openEditor).toHaveBeenCalledWith({ file: '/tmp/features/alpha/e2e/a.spec.ts', line: 5 })
})
it('shows an honest empty cold load', async () => {
  await render({ features: [] })
  expect(document.body.textContent).toContain('No changed test files')
})

it('starts a linked file at its requested change and persists navigation through the existing focus callback', async () => {
  const onFocus = vi.fn()
  await render({ focus: { file: 'e2e/a.spec.ts', line: 7, mode: 'code' }, onFocus })
  expect(document.body.textContent).toContain('Edit 2 / 2')
  await act(async () => button('Previous change').click())
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/a.spec.ts', line: 5, mode: 'code' })
  expect(document.body.textContent).toContain('Edit 1 / 2')
})
it('shows one accurate whole-file empty state when the selected baseline matches', async () => {
  const review = testFileReview(); review.before = review.after; review.patch = ''; review.assessment.tests = []
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  await render()
  expect(document.body.textContent).toContain('No differences from Git HEAD.')
  expect(button('Previous change').disabled).toBe(true)
  expect(button('Next change').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Choose another test')
})

it('places the language switch and baseline in the toolbar and changes in the footer', async () => {
  await render({ pendingRuns: [{ ...run, status: 'passed' }], focusRunId: 'run-1', focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  const toolbar = document.querySelector('.cl-context-toolbar')!
  expect(toolbar.firstElementChild?.getAttribute('aria-label')).toBe('Test description format')
  expect(toolbar.lastElementChild?.textContent).toContain('Compare current test with')
  expect([...toolbar.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
    'Git HEAD',
    'Run run-1',
  ])
  expect(toolbar.querySelector('[aria-label="Edit blocks in this file"]')).toBeNull()
  expect(document.querySelector('.cl-review-footer [aria-label="Test changes across this suite"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Suites ·')
  expect(document.body.textContent).not.toContain('Results belong to the recorded tests')
})
it('opens an unselected spec from its own row without changing the comparison', async () => {
  const review = testFileReview()
  vi.mocked(api.getTestFileReview).mockImplementation(async (_feature, file) => ({ ...review, file, currentPath: `/tmp/features/alpha/${file}` }))
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'cursor' })
  await render({ features: [feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts'])] })
  await click('Edit e2e/b.spec.ts in editor')
  expect(api.openEditor).toHaveBeenCalledWith({ file: '/tmp/features/alpha/e2e/b.spec.ts', line: 1 })
  expect(document.querySelector('.cl-review-file[aria-pressed="true"]')?.getAttribute('title')).toBe('e2e/a.spec.ts')
})
it('shows editor launch failures in the footer', async () => {
  vi.mocked(api.openEditor).mockResolvedValue({ opened: false, editor: 'cursor' })
  await render()
  await click('Edit e2e/a.spec.ts in editor')
  expect(document.querySelector('.cl-review-footer [role="alert"]')?.textContent).toContain('Could not open the editor')
})

it('uses the notification run suite when no feature is supplied', async () => {
  await render({ features: [feature('alpha'), feature('beta')], pendingRuns: [{ ...run, feature: 'beta' }], focusRunId: 'run-1' })
  expect([...document.querySelectorAll('[data-testid^="dirty-review-suite-"]')].map((item) => item.getAttribute('data-testid'))).toEqual(['dirty-review-suite-beta'])
  expect(api.getTestFileReview).toHaveBeenCalledWith('beta', 'e2e/a.spec.ts', undefined)
})
it('keeps a clean entry suite instead of substituting an unrelated dirty suite', async () => {
  await render({ features: [feature('alpha'), { ...feature('beta'), dirty: undefined }], focusFeature: 'beta', focus: { file: 'e2e/b.spec.ts' } })
  expect(document.querySelector('[data-testid="dirty-review-suite-alpha"]')).toBeNull()
  expect(document.querySelector('[data-testid="dirty-review-suite-beta"]')).not.toBeNull()
  expect(api.getTestFileReview).toHaveBeenCalledWith('beta', 'e2e/b.spec.ts', undefined)
  expect(button('Accept & commit')).toBeUndefined()
})

function setupTestChangeNavigation() {
  const original = testFileReview()
  const added = (file: string, names: string[]) => {
    const lines = ["import { test } from '@playwright/test'", '']
    const tests = names.map((name) => {
      const line = lines.length + 1
      lines.push(`test('${name}', async () => {`, '  await work()', '})', '')
      return { ...original.after.tests[0], name, line, endLine: line + 2 }
    })
    return { ...original, file, baseline: 'run-start' as const, before: { source: '', tests: [] },
      after: { source: lines.join('\n'), tests }, assessment: { ...original.assessment, tests: [] },
      patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}` }
  }
  const deleted = added('e2e/deleted.spec.ts', ['gone'])
  const reviews = [original, added('e2e/b.spec.ts', ['new first', 'new second']), added('e2e/z.spec.ts', ['new third']),
    { ...deleted, before: deleted.after, after: deleted.before,
      patch: `@@ -1,${deleted.after.source.split('\n').length} +0,0 @@\n${deleted.after.source.split('\n').map((line) => '-' + line).join('\n')}` }]
  const targets = (review: typeof original, side: 'before' | 'after') => review[side].tests.map(({ name, line, endLine }) => ({ file: review.file, name, line, endLine }))
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: reviews.map((review) => review.file),
    differences: reviews.map((review) => ({ file: review.file, affectedTests: review.after.tests.map((test) => test.name) })),
    changes: { added: [...targets(reviews[1], 'after'), ...targets(reviews[2], 'after')], changed: targets(original, 'after'), removed: targets(reviews[3], 'before') },
  })
  vi.mocked(api.getTestFileReview).mockImplementation(async (_feature, file) => reviews.find((review) => review.file === file)!)
  return { features: [{ ...feature(), dirty: undefined }], focusFeature: 'alpha', focusRunId: 'old-run',
    focusRunDetail: { manifest: { ...detail.manifest, runId: 'old-run', featureDir: '/source',
      suiteSnapshot: { kind: 'taken', dir: '/recorded', takenAt: 'now', digest: 'd' } } } as RunDetail }
}
const testNavigation = () => document.querySelector('[aria-label="Test changes across this suite"]')!
const changeMarks = () => [...testNavigation().querySelectorAll('.cl-test-change')]
  .map((mark) => `${mark.getAttribute('aria-label')}${mark.getAttribute('aria-pressed') === 'true' ? ' (showing)' : ''}`)

it('leaves a tag-only comparison neutral in both languages and recovers a stale Changed link', async () => {
  const props = setupTestChangeNavigation()
  const review = testFileReview()
  review.before.source = review.before.source.replace("test('a',", "test('a', { tag: '@old' },")
  review.after.source = review.before.source.replace('@old', '@new')
  review.patch = '@@ -1,8 +1,8 @@\n' + review.before.source.split('\n').flatMap((line, index) => index === 2 ? ['-' + line, '+' + line.replace('@old', '@new')] : [' ' + line]).join('\n')
  review.assessment.tests = []
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ state: 'ready', files: [review.file], differences: [], changes: { added: [], changed: [], removed: [] } })
  await render({ ...props, focus: { file: review.file, line: 3, test: 'a', change: 'changed', baseline: 'run', mode: 'code' } })
  for (const mode of ['Code', 'English']) {
    await click(mode)
    expect(changeMarks()).toEqual([])
    expect(document.querySelector('ins, del, [data-source-changed], tr[data-selected]')).toBeNull()
    expect(document.querySelector('.cl-review-file')?.getAttribute('data-changed')).toBeNull()
    expect(document.querySelector('.cl-context-assessment')?.textContent).toContain('Tag and formatting edits are excluded')
  }
})

it('navigates the suite test counts across files and displays only the selected declaration', async () => {
  const props = setupTestChangeNavigation()
  const onFocus = vi.fn()
  await render({ ...props, onFocus, focus: { file: 'e2e/b.spec.ts', line: 3, change: 'added', baseline: 'run', mode: 'code' } })
  expect(changeMarks()).toEqual(['Show 3 new tests (showing)', 'Show 1 changed test', 'Show 1 removed test'])
  expect(testNavigation().textContent).toContain('1 / 3')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('new first')
  expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  expect(document.querySelectorAll('tr[data-selected="true"]')).toHaveLength(0)
  expect(document.querySelector('tbody')?.textContent).not.toContain('new second')
  expect(document.querySelector('tbody')?.textContent).not.toContain('import')
  expect(document.querySelectorAll('ins')).toHaveLength(3)
  expect(document.querySelector('del')).toBeNull()
  expect(document.querySelector('tbody')?.textContent).toContain('Not present in recorded tests')
  expect(button('Previous test change').disabled).toBe(true)
  const table = document.querySelector('table')
  const reads = vi.mocked(api.getTestFileReview).mock.calls.length
  await click('Next test change')
  expect(document.querySelector('table')).toBe(table)
  expect(api.getTestFileReview).toHaveBeenCalledTimes(reads)
  expect(testNavigation().textContent).toContain('2 / 3')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('new second')
  expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
  expect(document.querySelector('tbody')?.textContent).not.toContain('new first')
  await click('Next test change')
  expect(testNavigation().textContent).toContain('3 / 3')
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/z.spec.ts', 'old-run')
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/z.spec.ts', line: 3, change: 'added', test: 'new third', baseline: 'run', mode: 'code' })
  expect(button('Next test change').disabled).toBe(true)
  await click('Previous test change')
  expect(testNavigation().textContent).toContain('2 / 3')
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/b.spec.ts', 'old-run')
})

it('counts a test with two separate code edits once and navigates removed tests on the recorded side', async () => {
  const props = setupTestChangeNavigation()
  const scrolled: Element[] = []
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this) })
  try {
    await render({ ...props, focus: { file: 'e2e/a.spec.ts', line: 3, change: 'changed', baseline: 'run', mode: 'code' } })
    expect(testNavigation().textContent).toContain('1 / 1')
    expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('a')
    expect(document.body.textContent).not.toContain('Edit 1 / 2')
    expect(button('Next test change').disabled).toBe(true)
    await click('Show 1 removed test')
    expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('gone')
    expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/deleted.spec.ts', 'old-run')
    expect(scrolled.at(-1)?.getAttribute('data-side')).toBe('before')
    expect(scrolled.at(-1)?.getAttribute('data-source-line')).toBe('3')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(document.querySelectorAll('del')).toHaveLength(3)
    expect(document.querySelector('ins')).toBeNull()
    expect(document.querySelector('tbody')?.textContent).toContain('Removed from current source')
    expect(document.querySelector('.cl-context-assessment')?.textContent).toBe('This test was removed from the current source.')
    await click('Show 3 new tests')
    expect(testNavigation().textContent).toContain('1 / 3')
  } finally { scroll.mockRestore() }
})

it('preserves the selected test and category while switching language or inspecting its actions', async () => {
  const props = setupTestChangeNavigation()
  const onFocus = vi.fn()
  await render({ ...props, onFocus, focus: { file: 'e2e/b.spec.ts', line: 7, change: 'added', baseline: 'run', mode: 'english' } })
  expect(testNavigation().textContent).toContain('2 / 3')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-side="after"][data-source-line="8"] button')!.click())
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/b.spec.ts', line: 7, change: 'added', test: 'new second', baseline: 'run', mode: 'code' })
  expect(testNavigation().textContent).toContain('2 / 3')
  await click('English')
  expect(testNavigation().textContent).toContain('2 / 3')
})

it('shows unavailable counts rather than a fabricated zero when a comparison fails', async () => {
  const props = setupTestChangeNavigation()
  vi.mocked(api.getTestSourceComparison).mockRejectedValue(new Error('Snapshot unavailable'))
  await render({ ...props, focus: { file: 'e2e/b.spec.ts', line: 3, change: 'added', baseline: 'run' } })
  expect(testNavigation().textContent).toContain('Unavailable')
  expect(changeMarks()).toEqual([])
  expect(button('Next test change').disabled).toBe(true)
  expect(document.querySelector('[aria-label="Edit blocks in this file"]')).toBeNull()
})

it('hides a kind with nothing in it and opens on a kind that has tests', async () => {
  const props = setupTestChangeNavigation()
  const ready = await api.getTestSourceComparison('alpha', 'old-run')
  if (ready.state !== 'ready') throw new Error('the navigation fixture must be a ready comparison')
  // Only removed tests, and the file the dialog opens on holds none of them. The
  // strip hides a kind at zero, so a fallback to `added` would light no mark at
  // all and report "No test changes" beside a mark that says one was removed.
  vi.mocked(api.getTestSourceComparison).mockResolvedValue({ ...ready, changes: { added: [], changed: [], removed: ready.changes.removed } })
  // No `change` in the focus: the category has to be derived, which is the point.
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(changeMarks()).toEqual(['Show 1 removed test (showing)'])
  expect(testNavigation().textContent).toContain('\u2014 / 1')
  await click('Next test change')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('gone')
  expect(testNavigation().textContent).toContain('1 / 1')
})

it('uses declaration targets even when a runtime roster expands them into more cases', async () => {
  const props = setupTestChangeNavigation()
  vi.mocked(api.getFeatureTests).mockResolvedValue([{ file: '/source/e2e/b.spec.ts', tests: Array.from({ length: 10 }, (_, index) => ({
    ...testFileReview().after.tests[0], name: `generated case ${index}`, line: 3, bodySource: '', steps: [],
  })) }])
  const onFocus = vi.fn()
  await render({ ...props, onFocus, focus: { file: 'e2e/b.spec.ts', line: 3, change: 'added', test: 'new first', baseline: 'run' } })
  expect(api.getFeatureTests).not.toHaveBeenCalled()
  const table = document.querySelector('table')
  const reads = vi.mocked(api.getTestFileReview).mock.calls.length
  await click('Next test change')
  expect(document.querySelector('table')).toBe(table)
  expect(api.getTestFileReview).toHaveBeenCalledTimes(reads)
  expect(testNavigation().textContent).toContain('2 / 3')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('new second')
  const saved = onFocus.mock.calls.at(-1)![0]
  act(() => root.unmount()); root = createRoot(container)
  await render({ ...props, focus: saved })
  expect(testNavigation().textContent).toContain('2 / 3')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('new second')
})

it('never highlights a different test if the source changes after the declaration list was loaded', async () => {
  const props = setupTestChangeNavigation()
  const readReview = vi.mocked(api.getTestFileReview).getMockImplementation()!
  vi.mocked(api.getTestFileReview).mockImplementation(async (...args) => {
    const review = await readReview(...args)
    return review.file === 'e2e/deleted.spec.ts' ? { ...review, before: { ...review.before, tests: review.before.tests.map((test) => ({ ...test, name: 'different test' })) } } : review
  })
  await render({ ...props, focus: { file: 'e2e/deleted.spec.ts', line: 3, change: 'removed', test: 'gone', baseline: 'run' } })
  expect(testNavigation().textContent).toContain('1 / 1')
  expect(document.querySelector('[data-testid="review-selected-test"]')?.textContent).toBe('gone')
  expect(document.body.textContent).toContain('matching declaration is unavailable in this source snapshot')
  expect(document.querySelectorAll('tr[data-selected="true"]')).toHaveLength(0)
})
