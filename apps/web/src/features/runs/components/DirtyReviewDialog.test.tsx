// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Feature, RunIndexEntry, RunDetail } from '@/shared/api/types'
import * as api from '@/shared/api/client'
import { testFileReview } from '@/shared/api/__fixtures__/test-review'
import { DirtyReviewDialog } from './DirtyReviewDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/shared/api/client', async (original) => ({ ...await original<typeof api>(),
  getTestFileReview: vi.fn(), getFeatureTests: vi.fn(), commitDirtySpecs: vi.fn(), adoptSpecEdits: vi.fn(), restoreSpecEdits: vi.fn(), openEditor: vi.fn(), openWorkspace: vi.fn(),
}))
vi.mock('../state/RunsContext', () => ({ useRun: () => ({ detail: undefined, error: null }) }))
let root: Root
let container: HTMLDivElement
const feature = (name = 'alpha', files = ['e2e/a.spec.ts']): Feature => ({ name, description: '', envs: [], repos: [], dirty: { status: 'dirty', specs: files.map((file) => ({ file, affectedTests: ['a'] })) } })
const run = { runId: 'run-1', feature: 'alpha', status: 'healing', pendingSpecEdits: 1 } as RunIndexEntry
const detail = { manifest: { runId: 'run-1', feature: 'alpha', specEdits: { pending: [{ file: 'e2e/a.spec.ts', affectedTests: ['a'] }] } } } as RunDetail
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getFeatureTests).mockResolvedValue([])
  vi.mocked(api.getTestFileReview).mockResolvedValue(testFileReview())
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: true })
  vi.mocked(api.adoptSpecEdits).mockResolvedValue({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (label: string) => buttons().find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!
async function render(props: Partial<Parameters<typeof DirtyReviewDialog>[0]> = {}) {
  await act(async () => root.render(<DirtyReviewDialog features={[feature()]} onClose={vi.fn()} {...props} />))
}
const click = async (label: string) => act(async () => button(label).click())
it('opens a clean suite against its selected historical run and lists files from both versions', async () => {
  const clean = { ...feature(), dirty: undefined }
  const historical = { manifest: { ...detail.manifest, runId: 'old-run', featureDir: '/source', suiteSnapshot: { kind: 'taken', dir: '/recorded', takenAt: 'now', digest: 'd' } } } as RunDetail
  vi.mocked(api.getFeatureTests).mockImplementation(async (_feature, _opts, runId) => (runId
    ? ['/recorded/e2e/a.spec.ts', '/recorded/e2e/deleted.spec.ts']
    : ['/source/e2e/a.spec.ts', '/source/e2e/new.spec.ts']).map((file) => ({ file, tests: [] })))
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

it('does not replace an explicitly selected historical baseline with another pending run', async () => {
  await render({ focusFeature: 'alpha', focusRunId: 'old-run', focus: { file: 'e2e/a.spec.ts', baseline: 'run' },
    focusRunDetail: { ...detail, manifest: { ...detail.manifest, runId: 'old-run' } }, pendingRuns: [run] })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'old-run')
  expect(button('Yes, commit & rerun')).toBeUndefined()
  expect(button('No, restore tests')).toBeUndefined()
})

it('keeps suite and file positions when selection, run context, and baseline change', async () => {
  const features = [feature('beta', ['e2e/z.spec.ts', 'e2e/a.spec.ts']), feature('alpha')]
  const betaRun = { ...run, feature: 'beta', status: 'passed' as const, pendingSpecEdits: 0 }
  const betaDetail = { manifest: { runId: 'run-1', feature: 'beta', specEdits: { pending: [] } } } as unknown as RunDetail
  const props = { features, pendingRuns: [betaRun], focusFeature: 'beta', focusRunId: 'run-1', focusRunDetail: betaDetail }
  const positions = () => [...document.querySelectorAll('nav .cl-review-file')].map((item) => item.getAttribute('title'))
  const suites = () => [...document.querySelectorAll('[data-testid^="dirty-review-suite-"]')].map((item) => item.getAttribute('data-testid'))
  const selectedFile = () => document.querySelector('.cl-review-file[aria-pressed="true"]')?.getAttribute('title')
  await render({ ...props, focus: { file: 'e2e/z.spec.ts', baseline: 'run' } })
  expect(suites()).toEqual(['dirty-review-suite-alpha', 'dirty-review-suite-beta'])
  expect(positions()).toEqual(['e2e/a.spec.ts', 'e2e/a.spec.ts', 'e2e/z.spec.ts'])
  expect(selectedFile()).toBe('e2e/z.spec.ts')
  expect(document.querySelector('[data-testid="dirty-review-suite-beta"]')?.textContent).toContain('Changed')
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('select')!; select.value = 'head'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('beta', 'e2e/z.spec.ts', undefined)
  expect(positions()).toEqual(['e2e/a.spec.ts', 'e2e/a.spec.ts', 'e2e/z.spec.ts'])
  expect(selectedFile()).toBe('e2e/z.spec.ts')
  await render({ ...props, pendingRuns: [], focusFeature: 'alpha', focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(suites()).toEqual(['dirty-review-suite-alpha', 'dirty-review-suite-beta'])
  expect(positions()).toEqual(['e2e/a.spec.ts', 'e2e/a.spec.ts', 'e2e/z.spec.ts'])
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  expect(document.querySelector('select')?.value).toBe('head')
  expect(document.querySelector<HTMLOptionElement>('option[value="run"]')?.disabled).toBe(true)
})

it('follows baseline navigation from the URL without moving the selected file', async () => {
  const props = { pendingRuns: [run], focusRunDetail: detail, focusRunId: 'run-1', focusFeature: 'alpha' }
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  await render({ ...props, focus: { file: 'e2e/a.spec.ts' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  await render({ ...props, focus: { file: 'e2e/a.spec.ts', baseline: 'run' } })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
})

it('lists a pending robustness envelope edit by name, not as zero tests', async () => {
  // D15: the envelope rides in the run-start copy, so a mid-run edit to it is
  // pending like a spec edit — but it declares exposure, not tests.
  const pending = { manifest: { runId: 'run-1', feature: 'alpha', specEdits: { pending: [
    { file: 'e2e/a.spec.ts', affectedTests: ['a'] },
    { file: 'robustness/envelope.json', affectedTests: [] },
  ] } } } as RunDetail
  await render({ features: [], pendingRuns: [run], focusFeature: 'alpha', focusRunId: 'run-1', focusRunDetail: pending })
  const rows = [...document.querySelectorAll('.cl-review-file')].map((item) => item.textContent)
  expect(rows.some((text) => text?.includes('a.spec.ts') && text.includes('1 test'))).toBe(true)
  expect(rows.some((text) => text?.includes('robustness/envelope.json') && text.includes('perturbation envelope'))).toBe(true)
  expect(document.body.textContent).not.toContain('0 tests')
})

it('shows a whole test with equal before/after columns, unchanged context and exact source edits', async () => {
  await render()
  await click('Code')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Committed tests · Git HEAD', 'Current source'])
  expect(document.querySelector('tbody')?.textContent).toContain('const context = x')
  expect(document.querySelector('del')?.textContent).toBe('  expect(x).toBe(1)')
  expect(document.querySelector('ins')?.textContent).toBe('  expect(x).toBe(2)')
  expect(document.body.textContent).toContain('Change 1 of 2')
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
  await click('Code'); await click('English')
  expect(document.body.textContent).toContain('Change 2 of 2')
  expect(document.querySelector('tbody')?.textContent).toContain('import { test')
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
    expect(document.body.textContent).toContain('Change 1 of 2')
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
  expect(document.body.textContent).toContain('Change 2 of 2')
  pane.scrollTop = 1900; pane.scrollLeft = 60
  await act(async () => document.querySelector<HTMLButtonElement>('button[data-side="after"][data-source-line="1"]')!.click())
  expect(button('English').getAttribute('aria-selected')).toBe('true')
  expect(pane.scrollTop).toBe(413)
  expect(pane.scrollLeft).toBe(17)
  expect(document.body.textContent).toContain('Change 1 of 2')
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
it('commits every changed file in the selected suite and retains a saved receipt when dirty state clears', async () => {
  const onClose = vi.fn()
  await render({ features: [feature('alpha', ['e2e/a.spec.ts', 'e2e/b.spec.ts']), feature('beta')], onClose })
  await click('Commit suite · 2 files')
  expect(api.commitDirtySpecs).toHaveBeenCalledExactlyOnceWith('alpha')
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
  await render({ features: [], onClose })
  expect(document.body.textContent).toContain('Saved in Git · 2 files in alpha')
  expect(document.body.textContent).toContain('No uncommitted test edits remain')
  expect(onClose).not.toHaveBeenCalled()
})
it('quietly refreshes an already-clean suite without claiming a new commit', async () => {
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: false, status: 'clean', reason: 'no modified specs' })
  const onFeaturesChanged = vi.fn()
  await render({ onFeaturesChanged }); await click('Commit suite · 1 file')
  expect(onFeaturesChanged).toHaveBeenCalledExactlyOnceWith()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.body.textContent).not.toContain('Saved in Git')
  await render({ features: [], onFeaturesChanged })
  expect(document.body.textContent).toContain('No uncommitted test edits remain')
  expect(button('Commit suite · 1 file')).toBeUndefined()
})
it('does not hide a no-op without confirmation that the suite is clean', async () => {
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: false, reason: 'no modified specs' })
  await render(); await click('Commit suite · 1 file')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('no modified specs')
  expect(button('Commit suite · 1 file').disabled).toBe(false)
})
it('surfaces a failed commit and allows retry', async () => {
  vi.mocked(api.commitDirtySpecs).mockRejectedValue(new Error('Git rejected the commit'))
  await render(); await click('Commit suite · 1 file')
  expect(document.body.textContent).toContain('Git rejected the commit')
  expect(button('Commit suite · 1 file').disabled).toBe(false)
})
it('offers exactly one yes/no decision and commits before accepting changes into the selected run', async () => {
  const onClose = vi.fn()
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  expect([...document.querySelectorAll('.cl-review-commit-buttons button')].map((item) => item.textContent)).toEqual(['No, restore tests', 'Yes, commit & rerun'])
  expect(document.body.textContent).toContain('Keep these test changes?')
  await click('Yes, commit & rerun')
  expect(api.commitDirtySpecs).toHaveBeenCalledExactlyOnceWith('alpha')
  expect(api.adoptSpecEdits).toHaveBeenCalledExactlyOnceWith('run-1')
  expect(vi.mocked(api.commitDirtySpecs).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.adoptSpecEdits).mock.invocationCallOrder[0])
  expect(api.restoreSpecEdits).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('restores the selected run tests on no without committing or accepting changes', async () => {
  const onClose = vi.fn()
  const onFeaturesChanged = vi.fn()
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose, onFeaturesChanged })
  await click('No, restore tests')
  expect(api.restoreSpecEdits).toHaveBeenCalledWith('run-1')
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
  expect(api.commitDirtySpecs).not.toHaveBeenCalled()
  expect(onFeaturesChanged).toHaveBeenCalledExactlyOnceWith()
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('keeps the decision open when restoring fails', async () => {
  const onClose = vi.fn()
  vi.mocked(api.restoreSpecEdits).mockRejectedValue(new Error('tests-running'))
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('No, restore tests')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('tests-running')
  expect(onClose).not.toHaveBeenCalled()
  expect(button('No, restore tests').disabled).toBe(false)
})
it.each(['rejected', 'no-op'])('does not accept edits when the commit is %s', async (failure) => {
  const onClose = vi.fn()
  if (failure === 'rejected') vi.mocked(api.commitDirtySpecs).mockRejectedValue(new Error('Git rejected the commit'))
  else vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: false, reason: 'No files committed' })
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Yes, commit & rerun')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  expect(button('Yes, commit & rerun').disabled).toBe(false)
})
it('can retry accepting already-committed tests after the run rejects them', async () => {
  const onClose = vi.fn()
  vi.mocked(api.adoptSpecEdits).mockRejectedValueOnce(new Error('tests-running'))
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Yes, commit & rerun')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Saved in Git, but the run could not accept the changes.')
  expect(onClose).not.toHaveBeenCalled()
  vi.mocked(api.commitDirtySpecs).mockResolvedValue({ committed: false, status: 'clean' })
  // The Git watcher removes the dirty feature after the successful commit;
  // pending run edits must still expose the same decision for retry.
  await render({ features: [], pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Yes, commit & rerun')
  expect(api.adoptSpecEdits).toHaveBeenCalledTimes(2)
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it('discloses when changes were accepted but no rerun could start', async () => {
  const onClose = vi.fn()
  vi.mocked(api.adoptSpecEdits).mockResolvedValue({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'not-waiting-for-signal' })
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Yes, commit & rerun')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('no rerun started')
  expect(onClose).not.toHaveBeenCalled()
})
it('closes when the accepted changes already have a pending rerun signal', async () => {
  const onClose = vi.fn()
  vi.mocked(api.adoptSpecEdits).mockResolvedValue({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'signal-already-pending' })
  await render({ pendingRuns: [run], focusRunDetail: detail, onClose })
  await click('Yes, commit & rerun')
  expect(onClose).toHaveBeenCalledExactlyOnceWith()
})
it.each([
  { ...run, status: 'queued' as const },
  { ...run, pendingSpecEdits: 0 },
  { ...run, status: 'passed' as const },
])('does not offer run actions without active pending edits: %o', async (pending) => {
  await render({ pendingRuns: [pending] })
  expect(button('Yes, commit & rerun')).toBeUndefined()
  expect(button('No, restore tests')).toBeUndefined()
  await click('Commit suite · 1 file')
  expect(api.adoptSpecEdits).not.toHaveBeenCalled()
})
it('uses the selected run snapshot only when reviewing differences from that run', async () => {
  await render({ pendingRuns: [run], focusRunDetail: detail, focusRunId: 'run-1' })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', undefined)
  vi.mocked(api.getTestFileReview).mockResolvedValue({ ...testFileReview(), baseline: 'run-start' })
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Compare current source with"]')!; select.value = 'run'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.getTestFileReview).toHaveBeenLastCalledWith('alpha', 'e2e/a.spec.ts', 'run-1')
  expect([...document.querySelectorAll('thead th')].map((item) => item.textContent)).toEqual(['Recorded tests', 'Current source'])
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
  expect(button('Yes, commit & rerun')).toBeUndefined()
  expect(button('No, restore tests')).toBeUndefined()
  expect(button('Commit suite · 1 file')).toBeUndefined()
})
it('shows a recoverable empty state when a completed run has no selected file', async () => {
  await render({ features: [], pendingRuns: [{ ...run, status: 'passed', pendingSpecEdits: 0 }], focusRunId: 'run-1', focus: { baseline: 'run' } })
  expect(button('Pending test edits')).toBeUndefined()
  expect(document.body.textContent).not.toContain('Loading test files')
  expect(document.querySelector('[role="status"]')?.textContent).toContain('open a comparison from the Tests panel')
  expect(api.getTestFileReview).not.toHaveBeenCalled()
})
it('discloses missing source and retries instead of presenting it as removed code', async () => {
  vi.mocked(api.getTestFileReview).mockRejectedValueOnce(new Error('Snapshot unavailable'))
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Snapshot unavailable')
  expect(document.querySelector('del')).toBeNull()
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No changes')
  expect(button('Next change').disabled).toBe(true)
  await click('Retry')
  expect(document.querySelector('table')).not.toBeNull()
})
it('does not claim the baseline matches while source is still loading', async () => {
  vi.mocked(api.getTestFileReview).mockReturnValue(new Promise(() => {}))
  await render()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading complete test source')
  expect(document.body.textContent).not.toContain('This file matches')
  expect(document.body.textContent).not.toContain('No changes')
})
it('opens the existing editor at the test source without creating a new screen', async () => {
  vi.mocked(api.openEditor).mockResolvedValue({ opened: true, editor: 'cursor' })
  await render(); await click('Edit in editor')
  expect(api.openEditor).toHaveBeenCalledWith({ file: '/tmp/features/alpha/e2e/a.spec.ts', line: 5 })
})
it('retains the advisory disclosure and an honest empty cold load', async () => {
  await render({ features: [] })
  expect(document.body.textContent).toContain('No changed test files')
  await click('About this check')
  expect(document.querySelector('[data-testid="dirty-review-hint-copy"]')?.textContent).toContain('advisory')
})

it('starts a linked file at its requested change and persists navigation through the existing focus callback', async () => {
  const onFocus = vi.fn()
  await render({ focus: { file: 'e2e/a.spec.ts', line: 7, mode: 'code' }, onFocus })
  expect(document.body.textContent).toContain('Change 2 of 2')
  await act(async () => button('Previous change').click())
  expect(onFocus).toHaveBeenLastCalledWith({ file: 'e2e/a.spec.ts', line: 5, mode: 'code' })
  expect(document.body.textContent).toContain('Change 1 of 2')
})
it('shows one accurate whole-file empty state when the selected baseline matches', async () => {
  const review = testFileReview(); review.before = review.after; review.patch = ''; review.assessment.tests = []
  vi.mocked(api.getTestFileReview).mockResolvedValue(review)
  await render()
  expect(document.body.textContent).toContain('This file matches Git HEAD.')
  expect(button('Previous change').disabled).toBe(true)
  expect(button('Next change').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Choose another test')
})
